import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(projectRoot, "dist");

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

await Promise.all([
  cp(path.join(projectRoot, "web"), path.join(outputRoot, "web"), { recursive: true }),
  cp(path.join(projectRoot, "src"), path.join(outputRoot, "src"), { recursive: true }),
  cp(path.join(projectRoot, "node_modules", "@nesjs", "core", "dist", "esm"), path.join(outputRoot, "vendor", "nesjs", "core", "dist", "esm"), { recursive: true }),
]);

await cp(path.join(projectRoot, "web", "index.html"), path.join(outputRoot, "index.html"));
await rm(path.join(outputRoot, "web", "index.html"));

const coreLicense = await readFile(path.join(projectRoot, "node_modules", "@nesjs", "core", "LICENSE.md"), "utf8");
const glyphLicense = await readFile(path.join(projectRoot, "LICENSES-glyphs.txt"), "utf8");
const licenseText = `NESTERM\nCopyright (c) 2026\n\nThis distribution includes @nesjs/core 2.7.0.\nSource: https://github.com/taiyuuki/nesjs\nLicense: MIT\n\n${coreLicense}\n\n${glyphLicense}`;
await writeFile(path.join(outputRoot, "LICENSES.txt"), licenseText, "utf8");

const htaccess = `Options -Indexes\nDirectoryIndex index.html\nAddDefaultCharset UTF-8\n<IfModule mod_rewrite.c>\n  RewriteEngine On\n  RewriteCond %{HTTPS} !=on\n  RewriteRule ^(.*)$ https://%{HTTP_HOST}%{REQUEST_URI} [R=301,L]\n</IfModule>\n<IfModule mod_headers.c>\n  Header set X-Content-Type-Options "nosniff"\n  Header set Referrer-Policy "no-referrer"\n  Header set Cache-Control "no-cache"\n  Header set Permissions-Policy "camera=(), microphone=(), geolocation=()"\n</IfModule>\n<IfModule mod_mime.c>\n  AddType text/javascript .mjs\n</IfModule>\n<FilesMatch "^\\.">\n  Require all denied\n</FilesMatch>\n`;
await writeFile(path.join(outputRoot, ".htaccess"), htaccess, "utf8");

console.log(`Built static site: ${outputRoot}`);
