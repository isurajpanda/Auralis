// Syncs the Vite build output (dist/) into the local nginx html/ dir so that
// https://surajpanda.qzz.io/ always serves the latest frontend. Preserves nginx-owned
// files like 50x.html. Override target with NGINX_HTML_DIR env var.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const frontendDir = resolve(here, '..')
const distDir = join(frontendDir, 'dist')
const targetDir =
  process.env.NGINX_HTML_DIR || resolve(frontendDir, '..', '..', 'nginx-1.30.4', 'html')

if (!existsSync(distDir)) {
  console.error(`[deploy-nginx] dist/ not found at ${distDir} — run 'vite build' first.`)
  process.exit(1)
}
if (!existsSync(targetDir)) {
  console.warn(`[deploy-nginx] target not found at ${targetDir} — skipping (nothing deployed).`)
  process.exit(0)
}

const targetAssets = join(targetDir, 'assets')
mkdirSync(targetAssets, { recursive: true })

// Remove previous hashed app bundles, keep fonts and nginx-owned files.
for (const f of readdirSync(targetAssets)) {
  if (/^index-[A-Za-z0-9_-]+\.(js|css)(\.map)?$/.test(f)) {
    rmSync(join(targetAssets, f), { force: true })
    console.log(`[deploy-nginx] removed stale ${f}`)
  }
}

cpSync(join(distDir, 'index.html'), join(targetDir, 'index.html'))
cpSync(join(distDir, 'assets'), targetAssets, { recursive: true })
console.log(`[deploy-nginx] deployed ${distDir} -> ${targetDir}`)
