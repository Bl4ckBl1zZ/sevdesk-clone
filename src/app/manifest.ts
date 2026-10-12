import type { MetadataRoute } from "next";

/** PWA manifest, served as /manifest.webmanifest (04-ui-ux §10). Icons are rendered from assets/icon.svg. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Rechnungen",
    short_name: "Rechnungen",
    description: "Rechnungen und Buchhaltung",
    lang: "de-DE",
    dir: "ltr",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#ffffff",
    theme_color: "#16a34a",
    categories: ["business", "finance", "productivity"],
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
