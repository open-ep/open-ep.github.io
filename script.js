// Tailwind Configuration
// We configure this here so the Tailwind CDN can pick up our custom theme
tailwind.config = {
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
      },
      colors: {
        'paper-white': '#fdfbf7', // Warm paper feel
        'ink-black': '#1a1a1a',   // Deep e-ink black
      },
      animation: {
          blob: "blob 7s infinite",
      },
      keyframes: {
          blob: {
              "0%": { transform: "translate(0px, 0px) scale(1)" },
              "33%": { transform: "translate(30px, -50px) scale(1.1)" },
              "66%": { transform: "translate(-20px, 20px) scale(0.9)" },
              "100%": { transform: "translate(0px, 0px) scale(1)" },
          }
      }
    },
  },
};

// Interaction Logic
document.addEventListener('DOMContentLoaded', () => {
    // Mobile Menu Toggle
    const btn = document.getElementById('mobile-menu-btn');
    const menu = document.getElementById('mobile-menu');

    if (btn && menu) {
        btn.addEventListener('click', () => {
            menu.classList.toggle('hidden');
        });
    }
});
