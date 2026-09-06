/* ══════════════════════════════════════════════════════════════════════
   pcb.js — build a textured 3D board straight from JLCPCB Gerber output.

   There is no 3D model in the fab package, but the Gerbers carry everything
   needed to draw one: Edge_Cuts gives the outline, F/B_Cu the copper,
   F/B_Mask the solder-mask openings, F/B_Silkscreen the legend, and the
   drill file the holes. Those get rasterised into two face textures and
   mapped onto a board slab.

   Scope note — this board's Gerbers use only the subset implemented here:
   G01 linear (no G02/G03 arcs anywhere), all-Dark polarity, and C / R /
   RoundRect apertures. Obround (O) is included since it is cheap. Anything
   outside that (arcs, clear polarity, arbitrary aperture macros) is not
   handled and would need adding.
   ══════════════════════════════════════════════════════════════════════ */
(function (global) {
'use strict';

/* ── Gerber parsing ─────────────────────────────────────────────────── */

function parseGerber(text){
  let decs = 6;                                   // %FSLAX46Y46*% -> 6 decimals
  const fs = text.match(/%FSLAX(\d)(\d)Y\d\d\*%/);
  if(fs) decs = +fs[2];
  const toMM = s => parseInt(s,10) / Math.pow(10,decs);

  const aps = {};
  let cur = null, x = 0, y = 0;
  const ops = [];
  let inRegion = false, region = null;

  /* aperture definitions */
  const adRe = /%ADD(\d+)([A-Za-z_$][\w$.]*),([^*%]*)\*%/g;
  let m;
  while((m = adRe.exec(text))){
    const id = +m[1], kind = m[2];
    const p = m[3].split('X').map(parseFloat);
    if(kind === 'C')      aps[id] = {kind:'C', d:p[0]};
    else if(kind === 'R') aps[id] = {kind:'R', w:p[0], h:p[1]};
    else if(kind === 'O') aps[id] = {kind:'O', w:p[0], h:p[1]};
    else if(kind === 'RoundRect'){
      /* $1 = corner radius, $2..$9 = the four corner points */
      aps[id] = {kind:'RR', r:p[0],
                 pts:[[p[1],p[2]],[p[3],p[4]],[p[5],p[6]],[p[7],p[8]]]};
    }
    /* unknown macro -> approximate with a small circle so it is at least visible */
    else aps[id] = {kind:'C', d:p[0] || 0.2};
  }

  /* strip parameter blocks so they don't confuse the command scan */
  const body = text.replace(/%[^%]*%/g, '');

  for(const raw of body.split('*')){
    const s = raw.trim();
    if(!s || s.startsWith('G04')) continue;

    if(/^G36$/.test(s)){ inRegion = true; region = []; continue; }
    if(/^G37$/.test(s)){
      if(region && region.length > 2) ops.push({type:'region', pts:region});
      inRegion = false; region = null; continue;
    }

    const dsel = s.match(/^(?:G54)?D(\d+)$/);
    if(dsel && +dsel[1] >= 10){ cur = +dsel[1]; continue; }

    const cx = s.match(/X(-?\d+)/), cy = s.match(/Y(-?\d+)/);
    const dc = s.match(/D0?([123])$/);
    if(!cx && !cy && !dc) continue;

    const nx = cx ? toMM(cx[1]) : x;
    const ny = cy ? toMM(cy[1]) : y;
    const d  = dc ? +dc[1] : null;

    if(inRegion){
      if(d === 2) region = [[nx,ny]];
      else if(d === 1 && region) region.push([nx,ny]);
    } else {
      if(d === 1)      ops.push({type:'line', ap:cur, x1:x, y1:y, x2:nx, y2:ny});
      else if(d === 3) ops.push({type:'flash', ap:cur, x:nx, y:ny});
    }
    x = nx; y = ny;
  }
  return {aps, ops};
}

/* Excellon drill — this file is INCH, absolute, with explicit decimals */
function parseDrill(text){
  const tools = {}, holes = [];
  let cur = null;
  const inch = !/METRIC/.test(text);
  const k = inch ? 25.4 : 1;

  for(const raw of text.split(/\r?\n/)){
    const s = raw.trim();
    let m;
    if((m = s.match(/^T(\d+)C([\d.]+)/))) { tools[+m[1]] = parseFloat(m[2])*k; continue; }
    if((m = s.match(/^T(\d+)$/)))         { cur = +m[1]; continue; }
    if((m = s.match(/^X(-?[\d.]+)Y(-?[\d.]+)/))){
      holes.push({x:parseFloat(m[1])*k, y:parseFloat(m[2])*k, d:tools[cur] || 0.3});
    }
  }
  return holes;
}

/* ── rasterising ────────────────────────────────────────────────────── */

function bounds(parsed){
  const b = {minX:1e9, minY:1e9, maxX:-1e9, maxY:-1e9};
  const hit = (x,y)=>{ b.minX=Math.min(b.minX,x); b.maxX=Math.max(b.maxX,x);
                       b.minY=Math.min(b.minY,y); b.maxY=Math.max(b.maxY,y); };
  parsed.ops.forEach(o=>{
    if(o.type==='line'){ hit(o.x1,o.y1); hit(o.x2,o.y2); }
    else if(o.type==='flash') hit(o.x,o.y);
    else o.pts.forEach(p=>hit(p[0],p[1]));
  });
  return b;
}

/* path for one aperture, centred on the origin */
function aperturePath(ctx, ap, S){
  ctx.beginPath();
  if(ap.kind === 'C'){
    ctx.arc(0, 0, ap.d*S/2, 0, Math.PI*2);
  } else if(ap.kind === 'R'){
    ctx.rect(-ap.w*S/2, -ap.h*S/2, ap.w*S, ap.h*S);
  } else if(ap.kind === 'O'){
    const w=ap.w*S, h=ap.h*S, r=Math.min(w,h)/2;
    if(ctx.roundRect) ctx.roundRect(-w/2, -h/2, w, h, r);
    else ctx.rect(-w/2, -h/2, w, h);
  } else if(ap.kind === 'RR'){
    ap.pts.forEach((p,i)=>{
      const px = p[0]*S, py = -p[1]*S;
      i ? ctx.lineTo(px,py) : ctx.moveTo(px,py);
    });
    ctx.closePath();
  }
}

/* draw one gerber layer into ctx, in a single colour */
function drawLayer(ctx, parsed, T, colour){
  const {S, ox, oy} = T;                       // mm -> px
  const X = x => (x - ox)*S;
  const Y = y => (oy - y)*S;                   // gerber Y up, canvas Y down

  ctx.save();
  ctx.fillStyle = colour;
  ctx.strokeStyle = colour;

  for(const o of parsed.ops){
    if(o.type === 'region'){
      ctx.beginPath();
      o.pts.forEach((p,i)=> i ? ctx.lineTo(X(p[0]),Y(p[1])) : ctx.moveTo(X(p[0]),Y(p[1])));
      ctx.closePath();
      ctx.fill();
      continue;
    }

    const ap = parsed.aps[o.ap];
    if(!ap) continue;

    if(o.type === 'line'){
      /* traces are drawn with circular apertures; width = diameter */
      const w = (ap.kind==='C' ? ap.d : Math.min(ap.w||0.2, ap.h||0.2)) * S;
      ctx.lineWidth = Math.max(w, 0.7);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(X(o.x1), Y(o.y1));
      ctx.lineTo(X(o.x2), Y(o.y2));
      ctx.stroke();
    } else {                                    // flash
      ctx.save();
      ctx.translate(X(o.x), Y(o.y));
      aperturePath(ctx, ap, S);
      if(ap.kind === 'RR'){
        /* the KiCad RoundRect macro = the corner polygon grown by r,
           which is exactly a round-joined stroke of width 2r plus a fill */
        ctx.lineWidth = ap.r*2*S;
        ctx.lineJoin = 'round';
        ctx.lineCap  = 'round';
        ctx.stroke();
      }
      ctx.fill();
      ctx.restore();
    }
  }
  ctx.restore();
}

function newCanvas(w,h){
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/* Composite one face: mask green, copper tint, exposed pads, silkscreen. */
function faceTexture(cu, mask, silk, holes, T, W, H, mirror, C){
  const out = newCanvas(W,H);
  const g = out.getContext('2d');

  /* 1 — solder mask over bare laminate */
  g.fillStyle = C.mask;
  g.fillRect(0,0,W,H);

  /* 2 — copper under the mask reads slightly lighter */
  if(cu) drawLayer(g, cu, T, C.copper);

  /* 3 — exposed metal = copper ∩ mask opening.
         Mask gerbers are negative: what is drawn is where mask is absent.

         The openings must be rasterised to their own canvas first. A
         composite mode applies per draw call, so running the mask layer
         straight into 'destination-in' would clip the copper to pad 1, then
         to pad 2, and so on — leaving the intersection of every pad, i.e.
         nothing. One drawImage of the finished layer is the whole trick. */
  if(cu && mask){
    const openC = newCanvas(W,H);
    drawLayer(openC.getContext('2d'), mask, T, '#fff');

    const tmp = newCanvas(W,H);
    const t = tmp.getContext('2d');
    drawLayer(t, cu, T, '#fff');                 // copper silhouette
    t.globalCompositeOperation = 'destination-in';
    t.drawImage(openC, 0, 0);                    // single composite
    t.globalCompositeOperation = 'source-in';
    t.fillStyle = C.pad;
    t.fillRect(0,0,W,H);
    g.drawImage(tmp,0,0);
  }

  /* 4 — legend */
  if(silk) drawLayer(g, silk, T, C.silk);

  /* 5 — drilled holes */
  if(holes && holes.length){
    g.fillStyle = C.hole;
    holes.forEach(h=>{
      g.beginPath();
      g.arc((h.x-T.ox)*T.S, (T.oy-h.y)*T.S, h.d*T.S/2, 0, Math.PI*2);
      g.fill();
    });
  }

  /* the back face is seen from the other side */
  if(mirror){
    const f = newCanvas(W,H);
    const fc = f.getContext('2d');
    fc.translate(W,0); fc.scale(-1,1);
    fc.drawImage(out,0,0);
    return f;
  }
  return out;
}

/* ── components ─────────────────────────────────────────────────────────
   Gerbers describe copper, mask, legend and holes — never component bodies.
   So positions and footprints below are measured from F_Paste (exact), while
   package identity and colour are read off the KiCad 3D-view renders of the
   populated board (a judgement call, not data). Origin is the board's
   top-left corner: x right, y down-negative, both mm.

   Cross-checks that the mapping is right rather than plausible:
     · R6 and R2 flash a 2.85 × 1.40 aperture where every cap in the same
       column flashes 2.90 × 1.45 — the two resistors fall exactly where the
       silkscreen says R6 and R2 are.
     · Q1 is three 0.70 × 0.45 pads, two at x 18.304 spaced 1.30 in y and one
       at x 20.304 — a SOT-23 with its leads on the x axis.
   ────────────────────────────────────────────────────────────────────── */

const COMPONENTS = [
  /* left column, 0805 (pads 1.00 × 1.45 on 1.90 centres) */
  {ref:'C6',  x:12.70, y:-8.13,  kind:'cap'},
  {ref:'C4',  x:12.70, y:-10.67, kind:'cap'},
  {ref:'C3',  x:12.70, y:-13.21, kind:'cap'},
  {ref:'R6',  x:12.70, y:-15.75, kind:'res'},
  {ref:'C2',  x:12.70, y:-18.29, kind:'cap'},
  {ref:'R2',  x:12.70, y:-20.83, kind:'res'},

  /* right column, 0805 */
  {ref:'C10', x:19.30, y:-5.59,  kind:'cap'},
  {ref:'C9',  x:19.30, y:-8.13,  kind:'cap'},
  {ref:'C8',  x:19.30, y:-10.67, kind:'cap'},
  {ref:'C7',  x:19.30, y:-13.21, kind:'cap'},
  {ref:'C11', x:19.30, y:-15.75, kind:'cap'},
  {ref:'C12', x:19.30, y:-18.29, kind:'cap'},
  {ref:'Q1',  x:19.30, y:-20.97, kind:'sot23'},

  /* SOD-123 diodes, 0.90 × 1.20 pads on 3.30 centres.
     D2's polarity mark faces the other way in the render. */
  {ref:'D1',  x:27.43, y:-8.64,  kind:'diode'},
  {ref:'D2',  x:27.43, y:-11.99, kind:'diode', flip:true},
  {ref:'D3',  x:27.43, y:-15.34, kind:'diode'},

  /* larger chip resistor, 1.12 × 2.65 pads on 2.92 centres */
  {ref:'R1',  x:15.24, y:-23.88, kind:'res1210'},

  /* shielded inductor, 1.10 × 3.70 pads on 3.00 centres */
  {ref:'L1',  x:27.94, y:-20.83, kind:'inductor'},

  /* FPC/FFC connectors. Contact rows and hold-down tabs are from F_Paste;
     housing extents are scaled off the renders. */
  {ref:'J1',  x:5.90,  y:-13.21, kind:'fpc',
   w:6.6, h:17.1, t:1.2, pins:24, pitch:0.5, contactX:7.37, face:1},
  {ref:'J2',  x:45.60, y:-13.72, kind:'fpc',
   w:9.0, h:21.0, t:2.6, pins:8,  pitch:2.0, contactX:42.87, face:-1},
];

const CMAT = {
  capBody : 0xc4a052,   // tan MLCC
  capEnd  : 0xb4b8c0,
  resBody : 0x2a2d34,
  resEnd  : 0xb4b8c0,
  diode   : 0x16181d,
  band    : 0xc6cad2,
  sot     : 0x191c22,
  lead    : 0xbcc0c8,
  ind     : 0x6a6d74,
  conn    : 0xe4ddca,   // cream housing
  connDark: 0x282420,   // actuator
  gold    : 0xc7a75f,
};

function buildComponents(THREE, wmm, hmm, thick){
  const g = new THREE.Group();
  const M = {};
  const mat = (key, rough) => M[key] || (M[key] = new THREE.MeshStandardMaterial({
    color: CMAT[key], metalness: rough===undefined ? .25 : .55,
    roughness: rough===undefined ? .55 : rough, envMapIntensity:.8 }));

  const box = (w,h,t,m,x,y,z)=>{
    const b = new THREE.Mesh(new THREE.BoxGeometry(w,h,t), m);
    b.position.set(x,y,z);
    b.castShadow = b.receiveShadow = true;
    return b;
  };

  /* board-space (x from left, y down-negative) -> mesh-local */
  const LX = x => x - wmm/2;
  const LY = y => y + hmm/2;
  const top = thick/2;

  for(const c of COMPONENTS){
    const px = LX(c.x), py = LY(c.y);
    const part = new THREE.Group();

    if(c.kind === 'cap' || c.kind === 'res' || c.kind === 'res1210'){
      const isCap = c.kind === 'cap';
      const big   = c.kind === 'res1210';
      const w = big ? 3.2 : 2.0, h = big ? 2.5 : 1.25, t = big ? 0.60 : (isCap ? 0.85 : 0.55);
      const bodyM = mat(isCap ? 'capBody' : 'resBody', .58);
      const endM  = mat(isCap ? 'capEnd'  : 'resEnd', .38);
      part.add(box(w, h, t, bodyM, 0, 0, t/2));
      const e = w*0.20;
      part.add(box(e, h*1.02, t*1.04, endM, -(w-e)/2, 0, t/2));
      part.add(box(e, h*1.02, t*1.04, endM,  (w-e)/2, 0, t/2));

    } else if(c.kind === 'diode'){
      const w=2.6, h=1.5, t=1.0;
      part.add(box(w, h, t, mat('diode', .5), 0, 0, t/2));
      const bw = 0.34, sx = (c.flip ? 1 : -1) * (w/2 - bw/2 - 0.12);
      part.add(box(bw, h*1.02, t*1.02, mat('band', .35), sx, 0, t/2));

    } else if(c.kind === 'sot23'){
      /* leads exit along x: two pads one side, one the other */
      const w=1.30, h=2.05, t=0.95;
      part.add(box(w, h, t, mat('sot', .5), 0, 0, t/2 + 0.10));
      const lm = mat('lead', .35);
      part.add(box(0.70, 0.45, 0.12, lm, -1.00, -0.65, 0.06));
      part.add(box(0.70, 0.45, 0.12, lm, -1.00,  0.65, 0.06));
      part.add(box(0.70, 0.45, 0.12, lm,  1.00,  0.00, 0.06));

    } else if(c.kind === 'inductor'){
      const w=4.4, h=4.4, t=2.0;
      part.add(box(w, h, t, mat('ind', .62), 0, 0, t/2));

    } else if(c.kind === 'fpc'){
      const {w,h,t} = c;
      part.add(box(w, h, t, mat('conn', .62), 0, 0, t/2));
      /* actuator bar on the side the flex enters from */
      const bw = Math.min(1.8, w*0.28);
      part.add(box(bw, h*0.98, t*0.86, mat('connDark', .55),
                   c.face * (w/2 - bw/2), 0, t/2 + t*0.09));
      /* contact fingers, on the real pad row and pitch */
      const gm = mat('gold', .34);
      const span = (c.pins-1)*c.pitch;
      for(let i=0;i<c.pins;i++){
        part.add(box(Math.min(1.1, c.pitch*1.6), c.pitch*0.52, 0.10, gm,
                     LX(c.contactX) - px,
                     -span/2 + i*c.pitch,
                     0.05));
      }
    }

    part.position.set(px, py, top);
    part.userData.ref = c.ref;
    g.add(part);
  }
  return g;
}

/* ── public API ─────────────────────────────────────────────────────── */

const COLOURS = {
  mask  : '#0d5c39',
  copper: '#12704a',
  pad   : '#d3d8e0',        // HASL, per the job file's "Finish: None"
  silk  : '#eef1ea',
  hole  : '#0a0d12',
  edge  : '#93855c',        // raw FR4 rim
};

/**
 * buildPCB(THREE, opts) -> Promise<{group, size, thickness, holes, board}>
 * opts: { base, name, thickness, pxPerMM, colours }
 */
global.buildPCB = async function buildPCB(THREE, opts){
  const o = Object.assign({
    base: 'assets/jlcpcb/',   /* published copy — see index.html SRC */
    name: 'Display Driver',
    thickness: 1.6,
    pxPerMM: 38,
    colours: COLOURS,
  }, opts || {});
  const C = Object.assign({}, COLOURS, o.colours);

  const get = async (suffix, required) => {
    const url = o.base + encodeURIComponent(`${o.name}-${suffix}`);
    const r = await fetch(url);
    if(!r.ok){
      if(required) throw new Error(`${r.status} ${r.statusText} — ${url}`);
      return null;
    }
    return r.text();
  };

  const [edgeT, fcuT, fmaskT, fsilkT, bcuT, bmaskT, bsilkT, drlT] =
    await Promise.all([
      get('Edge_Cuts.gbr', true), get('F_Cu.gbr', true),
      get('F_Mask.gbr'), get('F_Silkscreen.gbr'),
      get('B_Cu.gbr'), get('B_Mask.gbr'), get('B_Silkscreen.gbr'),
      get('PTH.drl'),
    ]);

  const edge  = parseGerber(edgeT);
  const b     = bounds(edge);
  const wmm   = b.maxX - b.minX;
  const hmm   = b.maxY - b.minY;

  const cu    = parseGerber(fcuT);
  const mask  = fmaskT  ? parseGerber(fmaskT)  : null;
  const silk  = fsilkT  ? parseGerber(fsilkT)  : null;
  const bcu   = bcuT    ? parseGerber(bcuT)    : null;
  const bmask = bmaskT  ? parseGerber(bmaskT)  : null;
  const bsilk = bsilkT  ? parseGerber(bsilkT)  : null;
  const holes = drlT    ? parseDrill(drlT)     : [];

  const S = o.pxPerMM;
  const W = Math.round(wmm*S), H = Math.round(hmm*S);
  const T = {S, ox:b.minX, oy:b.maxY};

  const topC = faceTexture(cu,  mask,  silk,  holes, T, W, H, false, C);
  const botC = faceTexture(bcu, bmask, bsilk, holes, T, W, H, true,  C);

  const tex = c => {
    const t = new THREE.CanvasTexture(c);
    t.encoding = THREE.sRGBEncoding;
    t.anisotropy = 8;
    return t;
  };

  const face = t => new THREE.MeshStandardMaterial({
    map: tex(t), metalness:.22, roughness:.62, envMapIntensity:.75 });
  const rim  = new THREE.MeshStandardMaterial({
    color: C.edge, metalness:.10, roughness:.80 });

  /* BoxGeometry material order: +X, -X, +Y, -Y, +Z, -Z */
  const geo = new THREE.BoxGeometry(wmm, hmm, o.thickness);
  const mesh = new THREE.Mesh(geo, [rim, rim, rim, rim, face(topC), face(botC)]);
  mesh.castShadow = mesh.receiveShadow = true;

  const group = new THREE.Group();
  group.add(mesh);

  const comps = (o.components === false)
    ? null : buildComponents(THREE, wmm, hmm, o.thickness);
  if(comps) group.add(comps);

  /* tallest part above the board — the number that decides whether the
     assembly actually closes */
  let tallest = 0;
  if(comps) comps.children.forEach(p=>{
    const bb = new THREE.Box3().setFromObject(p);
    tallest = Math.max(tallest, bb.max.z - o.thickness/2);
  });

  return {
    group, mesh, comps,
    size: new THREE.Vector3(wmm, hmm, o.thickness),
    thickness: o.thickness,
    holes: holes.length,
    parts: comps ? comps.children.length : 0,
    tallest,
    board: {wmm, hmm, bounds:b},
    tris: geo.index ? geo.index.count/3 : geo.attributes.position.count/3,
  };
};

})(window);
