import type { Config } from 'tailwindcss';
export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // STAG: near-black green, the logo's neon green, and its gold as the warm second accent.
        bg: '#030504', panel: '#0A110D', panel2: '#0F1812', line: '#1B2B21', line2: '#27402F',
        text: '#EEF5EA', muted: '#9FB3A6', dim: '#6A7F72', cream: '#FFF8EA', ink: '#031207',
        brand: { DEFAULT: '#39FF14', hi: '#5DFF3B', lo: '#27CC0C' },
        gold: { DEFAULT: '#E8C35A', hi: '#F5DB8B' },
        violet: '#8B6BFF',
        up: '#4ADE80', down: '#FF5C5C',
      },
      backgroundImage: {
        'stag-grad': 'linear-gradient(180deg,#7BFF5E 0%,#39FF14 100%)',
        'stag-grad-v': 'linear-gradient(180deg,#5DFF3B 0%,#39FF14 55%,#0F1812 100%)',
        'stag-gold': 'linear-gradient(180deg,#F5DB8B 0%,#E8C35A 100%)',
        'stag-text': 'linear-gradient(90deg,#5DFF3B 0%,#39FF14 55%,#E8C35A 100%)',
      },
      fontFamily: {
        sans: ['var(--font-body)', 'system-ui', 'sans-serif'],
        display: ['var(--font-display)', 'system-ui', 'sans-serif'],
      },
      borderRadius: { xl2: '14px', xl3: '18px' },
      boxShadow: {
        card: '0 0 0 1px rgba(57,255,20,0.06), 0 18px 40px -18px rgba(0,0,0,0.8)',
        glow: '0 0 0 2px rgba(57,255,20,.45)',
        btn: '0 8px 24px -8px rgba(57,255,20,.55)',
        icon: '0 0 24px rgba(57,255,20,.35)',
      },
    },
  },
  plugins: [],
} satisfies Config;
