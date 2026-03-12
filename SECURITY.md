# Security & Build Verification

Kaption MCP Cloud Bridge is built and deployed exclusively through GitHub Actions CI. Every deployment is cryptographically signed using [Sigstore](https://sigstore.dev) keyless signing and recorded in a tamper-evident transparency chain.

## How It Works

1. **Build**: GitHub Actions builds the worker from source
2. **Hash**: A SHA-256 hash of the compiled worker is computed
3. **Sign**: The hash is signed using Sigstore keyless signing (tied to the GitHub Actions OIDC identity — no private keys to leak)
4. **Record**: The commit SHA, build hash, and Sigstore bundle URL are appended to an on-chain transparency log
5. **Deploy**: The signed worker is deployed to Cloudflare

Local deploys are blocked — `npm run deploy` fails outside CI.

## Verify a Deployment

### 1. Check the transparency chain

```bash
# Latest deployment
curl -s https://mcp-ext.kaptionai.com/transparency/latest | jq .

# Verify chain integrity (all hashes link correctly)
curl -s https://mcp-ext.kaptionai.com/transparency/verify | jq .
# → { "valid": true, "entries": N }

# Full history
curl -s https://mcp-ext.kaptionai.com/transparency | jq .
```

### 2. Verify the Sigstore signature

Download the signed artifact from the GitHub Actions run and verify with `cosign`:

```bash
# Install cosign
brew install cosign  # or: go install github.com/sigstore/cosign/v2/cmd/cosign@latest

# Get the latest commit SHA
COMMIT=$(curl -s https://mcp-ext.kaptionai.com/transparency/latest | jq -r '.event.commitSha')

# Download the artifact (requires GitHub CLI)
RUN_ID=$(gh -R Kaption-AI/mcp-extension-remote run list --commit $COMMIT --json databaseId -q '.[0].databaseId')
gh -R Kaption-AI/mcp-extension-remote run download $RUN_ID -n "signed-worker-$COMMIT" -D /tmp/verify

# Verify the signature
cosign verify-blob \
  --bundle /tmp/verify/worker.js.sigstore.json \
  --certificate-identity-regexp "https://github.com/Kaption-AI/mcp-extension-remote/.*" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  /tmp/verify/worker.js
# → Verified OK
```

### 3. What the signature proves

- The worker was built from the exact commit shown in the transparency chain
- It was built by GitHub Actions (not a developer's machine)
- The workflow file (`deploy.yml`) in the `Kaption-AI/mcp-extension-remote` repo produced it
- The build has not been tampered with since signing

## Security Properties

| Property | How |
|----------|-----|
| No local deploys | `npm run deploy` checks `$CI` env var |
| Keyless signing | Sigstore OIDC — no private keys to steal |
| Tamper-evident log | Transparency chain with hash chaining |
| Reproducible identity | Certificate binds to repo + workflow + commit |
| Public verification | Anyone can verify with `cosign` + the transparency API |
