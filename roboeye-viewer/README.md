# roboeye-viewer (published copy)

Interactive 3D viewer for ROBOEYE-100-M, linked from the "Explore in 3D"
button on the product card in `index.html`.

## Why the assets are duplicated

GitHub Pages can only serve files inside the repo, so this folder has to be
self-contained. `assets/` is a **copy** of:

| Here | Source of truth |
|------|-----------------|
| `assets/*.stl` | `F:\e-paper\stl\roboeye-100-M\` |
| `assets/jlcpcb/*` | `F:\e-paper\stl\roboeye-100-M\jlcpcb\` |

The development copy at `F:\e-paper\roboeye-viewer\` reads those originals in
place, so it always reflects the latest export. **This copy does not.** After
re-exporting from CAD or regenerating the fab package, re-sync:

```powershell
$dst = "F:\e-paper\open-ep.github.io\roboeye-viewer\assets"
Copy-Item "F:\e-paper\stl\roboeye-100-M\*.stl" $dst -Force
Copy-Item "F:\e-paper\stl\roboeye-100-M\jlcpcb\*" "$dst\jlcpcb" -Force
```

The only difference between the two copies is the asset path — `SRC` in
`index.html` and `base` in `pcb.js` point at `assets/` here, and at
`../stl/roboeye-100-M/` in the dev copy. Keep everything else in sync by
copying `index.html` and `pcb.js` over.

## Full documentation

`F:\e-paper\roboeye-viewer\README.md` — controls, the assembly breakdown, how
the board is built from Gerbers, the component mapping, and the clearance
notes. Worth reading before changing anything here.
