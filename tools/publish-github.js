'use strict';

/**
 * Publish the project to a GitHub repository using the REST API.
 *
 *   node tools/publish-github.js <repo-name> <token>
 *
 * Creates the repository (if it does not exist) and uploads every tracked
 * file in one commit. The token is only used from the command line and is
 * never written to disk.
 *
 * Scope needed on a fine-grained token: "Contents: Read and write" for the
 * one repository.
 */

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const ROOT = path.join(__dirname, '..');
const API = 'https://api.github.com';

function api(method, apiPath, token, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = https.request(
      `${API}${apiPath}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'own-proxy-publisher',
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            /* not json */
          }
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json);
          const message = json && json.message ? json.message : text.slice(0, 300);
          reject(new Error(`${method} ${apiPath} -> ${res.statusCode}: ${message}`));
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** Every file git knows about, minus ignored ones. */
function collectFiles() {
  const output = [];
  const skip = new Set(['.git', 'node_modules', '.github']);

  const walk = (dir, relative) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, rel);
      else output.push(rel);
    }
  };

  walk(ROOT, '');
  return output;
}

async function main() {
  const [, , repoArg, tokenArg] = process.argv;
  const repoName = repoArg || process.env.REPO_NAME || 'own-proxy';
  // Prefer the environment variable so the token never appears in the
  // process command line.
  const token = tokenArg || process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('usage: node tools/publish-github.js <repo-name> <token>');
    console.error('   or: GITHUB_TOKEN=... REPO_NAME=... node tools/publish-github.js');
    process.exit(1);
  }

  // 1. Who are we?
  const user = await api('GET', '/user', token);
  const owner = user.login;
  console.log(`publishing as ${owner}`);

  // 2. Create the repo if it is not there yet.
  const fullName = `${owner}/${repoName}`;
  let repo;
  try {
    repo = await api('GET', `/repos/${fullName}`, token);
    console.log(`using existing repository ${fullName}`);
  } catch {
    repo = await api('POST', '/user/repos', token, {
      name: repoName,
      description: 'Self-hosted web proxy: browse any website through your own proxy URL server.',
      private: false,
      auto_init: false,
    });
    console.log(`created repository ${fullName}`);
  }

  // 3. Build a tree with every file.
  //    NOTE: the git/trees endpoint takes the file contents as plain text.
  //    (Only the blob API expects base64.)
  const files = collectFiles();
  const tree = [];
  for (const rel of files) {
    const content = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    tree.push({
      path: rel,
      mode: '100644',
      type: 'blob',
      content,
    });
  }
  console.log(`uploading ${tree.length} files`);

  const createdTree = await api('POST', `/repos/${fullName}/git/trees`, token, { tree });
  if (createdTree.truncated) {
    throw new Error('the tree was truncated - too many files');
  }

  // 4. Commit it.
  const commit = await api('POST', `/repos/${fullName}/git/commits`, token, {
    message: 'own-proxy: web proxy with its own proxy URL server',
    tree: createdTree.sha,
    parents: [],
  });

  // 5. Point the default branch at it (create or force-update).
  const ref = `refs/heads/${repo.default_branch || 'main'}`;
  try {
    await api('PATCH', `/repos/${fullName}/git/refs/${ref.replace('refs/', '')}`, token, {
      sha: commit.sha,
      force: true,
    });
    console.log(`updated ${ref}`);
  } catch {
    await api('POST', `/repos/${fullName}/git/refs`, token, {
      ref,
      sha: commit.sha,
    });
    console.log(`created ${ref}`);
  }

  console.log('');
  console.log(`done -> https://github.com/${fullName}`);
}

main().catch((err) => {
  console.error('failed:', err.message);
  process.exit(1);
});
