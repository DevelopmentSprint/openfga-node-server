import { defineConfig } from 'vitepress'

// VitePress site config. Source markdown lives under docs-site/ (this
// directory); built static output is emitted to docs-site/.vitepress/
// dist/ and published to GitHub Pages by .github/workflows/docs.yml.
//
// The site is end-user documentation. Internal source-of-truth specs
// (PRD, feature specs, policies) remain under docs/ and are NOT mirrored
// here verbatim — every page here is written for an operator picking
// up the project, not a contributor aligning on architecture.
export default defineConfig({
  title: 'NodeFGA',
  description: 'NodeFGA — fine-grained authorization for Node. Relationship-based authorization built on the OpenFGA model.',

  // The deployed path is /openfga-node-server/ (GitHub Pages project
  // site). If the repo is ever renamed or moved to a custom domain,
  // update this base.
  base: '/openfga-node-server/',

  // CI builds with strict mode — broken links and bad frontmatter
  // fail the workflow rather than ship a degraded site.
  ignoreDeadLinks: false,

  cleanUrls: true,

  head: [
    ['meta', { name: 'theme-color', content: '#646cff' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'NodeFGA' }],
    ['meta', {
      property: 'og:description',
      content: 'NodeFGA — fine-grained authorization for Node.',
    }],
  ],

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Runbooks', link: '/runbooks/deployment' },
      { text: 'Recipes', link: '/recipes/github-permissions' },
      { text: 'GitHub', link: 'https://github.com/DevelopmentSprint/openfga-node-server' },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Overview', link: '/guide/getting-started' },
            { text: 'Installation', link: '/guide/installation' },
            { text: 'First Authorization Check', link: '/guide/first-check' },
          ],
        },
        {
          text: 'Configuration',
          items: [
            { text: 'Configuration File', link: '/guide/configuration' },
            { text: 'Environment Variables', link: '/guide/env-vars' },
            { text: 'Per-Environment Overrides', link: '/guide/per-env-overrides' },
          ],
        },
        {
          text: 'Authentication',
          items: [
            { text: 'Modes Overview', link: '/guide/authentication' },
            { text: 'Pre-Shared Keys', link: '/guide/auth-preshared' },
            { text: 'OIDC', link: '/guide/auth-oidc' },
          ],
        },
        {
          text: 'Observability',
          items: [
            { text: 'OpenTelemetry Tracing', link: '/guide/observability' },
            { text: 'Structured Logging', link: '/guide/logging' },
            { text: 'Health & Readiness', link: '/guide/health-readiness' },
          ],
        },
        {
          text: 'Operations',
          items: [
            { text: 'Idempotency', link: '/guide/idempotency' },
            { text: 'Database Backends', link: '/guide/database' },
            { text: 'TLS / HTTPS', link: '/guide/tls' },
          ],
        },
      ],
      '/runbooks/': [
        {
          text: 'Runbooks',
          items: [
            { text: 'Deployment', link: '/runbooks/deployment' },
            { text: 'Migrate to Upstream OpenFGA', link: '/runbooks/migrate-to-upstream-openfga' },
            { text: 'Rotate Pre-Shared Keys', link: '/runbooks/rotate-preshared-keys' },
            { text: 'Set Up OIDC Issuer', link: '/runbooks/setup-oidc' },
            { text: 'Enable OpenTelemetry', link: '/runbooks/enable-otel' },
            { text: 'Schema Migrations', link: '/runbooks/schema-migrations' },
          ],
        },
      ],
      '/recipes/': [
        {
          text: 'Recipes',
          items: [
            { text: 'GitHub-Style Permissions', link: '/recipes/github-permissions' },
            { text: 'Document Sharing', link: '/recipes/document-sharing' },
            { text: 'Auth0 / Okta FGA SDK Client', link: '/recipes/sdk-client' },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/DevelopmentSprint/openfga-node-server' },
    ],

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'NodeFGA — fine-grained authorization for Node.',
    },

    search: { provider: 'local' },

    editLink: {
      pattern: 'https://github.com/DevelopmentSprint/openfga-node-server/edit/develop/docs-site/:path',
      text: 'Edit this page on GitHub',
    },
  },
})
