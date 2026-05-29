#!/usr/bin/env node
// Generates a GitHub App installation token and prints it to stdout.
// Usage: GH_TOKEN=$(node scripts/bot-gh-token.js) gh pr create ...
//
// Reads PEM from OPENSLACK_GITHUB_APP_PRIVATE_KEY env or
// .openslack.local/github-app.pem (repo root).

const { createSign } = require("node:crypto");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");

const APP_ID = process.env.OPENSLACK_GITHUB_APP_ID || "3728623";
const INSTALLATION_ID =
  process.env.OPENSLACK_GITHUB_APP_INSTALLATION_ID || "135500236";

function b64url(input) {
  return Buffer.from(input)
    .toString("base64url")
    .replace(/=+$/, "");
}

function jwt(appId, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer
    .sign(privateKey)
    .toString("base64url")
    .replace(/=+$/, "");
  return `${header}.${payload}.${signature}`;
}

function getInstallationToken(appId, installationId, privateKey) {
  return new Promise((resolve, reject) => {
    const token = jwt(appId, privateKey);
    const req = https.request(
      {
        hostname: "api.github.com",
        path: `/app/installations/${installationId}/access_tokens`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "openslack-bot-gh",
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk.toString()));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`GitHub API ${res.statusCode}: ${body}`));
            return;
          }
          const data = JSON.parse(body);
          resolve(data.token);
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function main() {
  let privateKey = process.env.OPENSLACK_GITHUB_APP_PRIVATE_KEY;
  if (!privateKey) {
    const pemPath = path.resolve(
      __dirname,
      "..",
      ".openslack.local",
      "github-app.pem",
    );
    privateKey = fs.readFileSync(pemPath, "utf8");
  }

  if (!privateKey || !privateKey.includes("PRIVATE KEY")) {
    throw new Error("No valid PEM private key found");
  }

  const token = await getInstallationToken(APP_ID, INSTALLATION_ID, privateKey);
  process.stdout.write(token);
}

main().catch((err) => {
  process.stderr.write(err.message + "\n");
  process.exit(1);
});
