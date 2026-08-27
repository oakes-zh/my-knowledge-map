/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        primary: { 50: '#EEEDFE', 100: '#CECBF6', 600: '#534AB7', 800: '#3C3489' },
      },
    },
  },
  plugins: [],
};
