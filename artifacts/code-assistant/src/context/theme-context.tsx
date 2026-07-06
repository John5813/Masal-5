import { createContext, useContext, useState, useEffect, type ReactNode } from "react";

export type Theme = "dark" | "light";

interface ThemeContextValue {
  theme: Theme;
  toggle: () => void;
  setTheme: (t: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "dark",
  toggle: () => {},
  setTheme: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem("uz-theme");
      return saved === "light" || saved === "dark" ? saved : "dark";
    } catch {
      return "dark";
    }
  });

  useEffect(() => {
    const html = document.documentElement;
    html.classList.remove("light", "dark");
    html.classList.add(theme);
    try { localStorage.setItem("uz-theme", theme); } catch {}
  }, [theme]);

  const setTheme = (t: Theme) => setThemeState(t);
  const toggle   = () => setThemeState((t) => (t === "dark" ? "light" : "dark"));

  return (
    <ThemeContext.Provider value={{ theme, toggle, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
