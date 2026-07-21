/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Outfit', 'sans-serif'],
      },
      colors: {
        tg: {
          bg: '#0e1621',
          card: '#15202b',
          pill: '#192434',
          border: '#26354a',
          primary: '#58cc02',
          primaryDark: '#439b00',
          secondary: '#6b7d96',
          secondaryDark: '#526177',
          cyan: '#00d2ff',
        }
      },
    },
  },
  plugins: [],
};
