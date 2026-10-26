// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

const site = process.env.SITE_ORIGIN || "https://stuffbucket.github.io";
const base = process.env.SITE_BASE || "/woodchipper/";

export default defineConfig({
  site,
  base,
  integrations: [
    starlight({
      title: "Woodchipper",
      description: "Inspect binaries, apps, firmware, captures, and crashes with evidence.",
      favicon: "/favicon.svg",
      customCss: ["./src/styles/docs.css"],
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/stuffbucket/woodchipper" },
      ],
      editLink: { baseUrl: "https://github.com/stuffbucket/woodchipper/edit/main/site/" },
      sidebar: [
        { label: "Get started", link: "/start/" },
        { label: "What it does", link: "/what-it-does/" },
        { label: "Supported targets", link: "/supported-targets/" },
        { label: "Evidence and reports", link: "/evidence/" },
        {
          label: "Examples",
          items: [
            { label: "Overview", slug: "examples" },
            "examples/triage",
            "examples/feature-trace",
            "examples/clean-room-spec",
            "examples/security-audit",
            "examples/version-diff",
            "examples/firmware",
          ],
        },
        { label: "Run headless", link: "/headless/" },
        { label: "Commands", link: "/commands/" },
      ],
    }),
  ],
});
