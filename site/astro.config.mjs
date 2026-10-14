import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { groups } from "./src/data/plugins.mjs";

export default defineConfig({
  site: "https://opencode-plugins.vercel.app",
  output: "static",
  trailingSlash: "always",
  integrations: [
    starlight({
      title: "OpenCode Plugins",
      description: "Spencer Boucher's modular plugin suite for OpenCode 2. Background work, delegation, review, context and cost awareness, and a better terminal.",
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/justmytwospence/opencode-plugins" }],
      editLink: { baseUrl: "https://github.com/justmytwospence/opencode-plugins/edit/main/site/" },
      customCss: ["./src/styles/custom.css"],
      components: { Hero: "./src/components/Hero.astro", Footer: "./src/components/Footer.astro" },
      sidebar: [
        { label: "Start here", items: [
          { label: "Overview", slug: "guides/overview" },
          { label: "Install & select", slug: "guides/install" },
          { label: "Pin, update & rollback", slug: "guides/releases" },
          { label: "Requirements & costs", slug: "guides/requirements" },
          { label: "Built into OpenCode 2", slug: "guides/built-in" },
          { label: "Keyboard & commands", slug: "guides/keyboard" },
          { label: "Troubleshooting", slug: "guides/troubleshooting" },
        ] },
        { label: "Workflow recipes", items: [
          { label: "Background work & delegation", slug: "recipes/background-work" },
          { label: "Notebook sessions", slug: "recipes/notebooks" },
          { label: "Review loop", slug: "recipes/review-loop" },
          { label: "Context & cost", slug: "recipes/cache-cost" },
        ] },
        ...groups.map((group) => ({ label: group.title, collapsed: true, items: group.plugins.map((plugin) => ({ label: plugin.name, slug: "plugins/" + plugin.name })) })),
        { label: "Under the hood", items: [
          { label: "Development & testing", slug: "development" },
          { label: "About & credits", slug: "about" },
        ] },
      ],
      head: [
        { tag: "meta", attrs: { name: "theme-color", content: "#2449d8" } },
        { tag: "meta", attrs: { property: "og:image", content: "https://opencode-plugins.vercel.app/social.svg" } },
        { tag: "meta", attrs: { name: "author", content: "Spencer Boucher" } },
      ],
    }),
  ],
});
