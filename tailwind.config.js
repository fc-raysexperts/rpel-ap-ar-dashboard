/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        ink: '#14213D', // text
        navy: '#0F2547', // header band, table headings
        navy2: '#1B3A70',
        paper: '#F2F6FB', // page background
        line: '#DAE3EF',
        accent: '#2F6FED', // buttons, focus, the blue in the Credits card
        ledger: '#0B7A62', // debtors (money coming in)
        rust: '#C2362B', // creditors (money going out)
        brass: '#B7791F', // flags and warnings
      },
      fontFamily: {
        display: ['Manrope', '"IBM Plex Sans"', 'system-ui', 'sans-serif'],
        sans: ['"IBM Plex Sans"', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(15,37,71,0.06), 0 10px 28px -14px rgba(15,37,71,0.22)',
      },
    },
  },
  plugins: [],
};
