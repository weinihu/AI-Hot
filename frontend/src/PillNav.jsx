import { useEffect, useState } from "react";
import "./PillNav.css";

export default function PillNav({
  items,
  activeHref,
  className = "",
  baseColor = "var(--teal-dark)",
  pillColor = "var(--poster-soft)",
  hoveredPillTextColor = "var(--poster-soft)",
  pillTextColor = "var(--teal-dark)",
}) {
  const [currentHref, setCurrentHref] = useState(activeHref || items?.[0]?.href);

  useEffect(() => {
    const updateFromHash = () => {
      if (window.location.hash) setCurrentHref(window.location.hash);
    };
    updateFromHash();
    window.addEventListener("hashchange", updateFromHash);
    return () => window.removeEventListener("hashchange", updateFromHash);
  }, []);

  const cssVars = {
    "--base": baseColor,
    "--pill-bg": pillColor,
    "--hover-text": hoveredPillTextColor,
    "--pill-text": pillTextColor,
  };

  return (
    <nav className={`pill-nav ${className}`} aria-label="页面状态切换" style={cssVars}>
      <ul className="pill-list" role="list">
        {items.map((item) => {
          const isActive = currentHref === item.href;
          return (
            <li key={item.href}>
              <a
                href={item.href}
                className={`pill${isActive ? " is-active" : ""}`}
                aria-label={item.ariaLabel || item.label}
                aria-current={isActive ? "page" : undefined}
                onClick={() => setCurrentHref(item.href)}
              >
                <span className="hover-circle" aria-hidden="true" />
                <span className="label-stack">
                  <span className="pill-label">{item.label}</span>
                  <span className="pill-label-hover" aria-hidden="true">
                    {item.label}
                  </span>
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
