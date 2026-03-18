// Inline script to prevent dark mode flash on page load.
// This runs before React hydrates, reading the theme from localStorage
// and applying the "dark" class to <html> if needed.
// The script is a static string with no user input -- no XSS risk.

const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("certmate-theme");var d=t==="dark"||(t!=="light"&&window.matchMedia("(prefers-color-scheme:dark)").matches);if(d)document.documentElement.classList.add("dark")}catch(e){}})()`;

export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />;
}
