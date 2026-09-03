import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");

// Locate a build stage by its declared name rather than by its full FROM line.
// The contracts below are about what a stage contains, not which base image it
// derives from, so a deliberate base-image change must not read as a missing stage.
function extractStageSection(dockerfile, stageName) {
  const declaration = new RegExp(`^FROM .* AS ${stageName}[ \\t]*$`, "m");
  const match = declaration.exec(dockerfile);
  assert.ok(match, `missing build stage: ${stageName}`);
  const after = dockerfile.slice(match.index);
  const nextFromIndex = after.indexOf("\nFROM ");
  return nextFromIndex >= 0 ? after.slice(0, nextFromIndex) : after;
}

test("webapp-builder stage exports public PostHog and Sentry env without upload credentials", () => {
  const dockerfilePath = path.join(repoRoot, "Dockerfile");
  const raw = fs.readFileSync(dockerfilePath, "utf8");
  const section = extractStageSection(raw, "webapp-builder");
  const webappSection = extractStageSection(raw, "webapp");

  assert.match(section, /\bARG POSTHOG_HOST\b/);
  assert.match(section, /\bARG SENTRY_DSN\b/);
  assert.match(section, /\bARG SENTRY_RELEASE\b/);
  assert.doesNotMatch(section, /\bARG SENTRY_AUTH_TOKEN\b/);
  assert.doesNotMatch(section, /\bARG SENTRY_URL\b/);
  assert.match(section, /\bARG EXPO_PUBLIC_HAPPIER_SERVER_URL\b/);
  assert.match(section, /\bARG EXPO_PUBLIC_HAPPY_SERVER_URL\b/);
  assert.match(section, /\bARG EXPO_PUBLIC_SERVER_URL\b/);

  assert.match(section, /\bENV EXPO_PUBLIC_HAPPIER_SERVER_URL=\$EXPO_PUBLIC_HAPPIER_SERVER_URL\b/);
  assert.match(section, /\bENV EXPO_PUBLIC_HAPPY_SERVER_URL=\$EXPO_PUBLIC_HAPPY_SERVER_URL\b/);
  assert.match(section, /\bENV EXPO_PUBLIC_SERVER_URL=\$EXPO_PUBLIC_SERVER_URL\b/);
  assert.match(section, /\bENV EXPO_PUBLIC_POSTHOG_KEY=\$POSTHOG_API_KEY\b/);
  assert.match(section, /\bENV EXPO_PUBLIC_POSTHOG_HOST=\$POSTHOG_HOST\b/);
  assert.match(section, /\bENV EXPO_PUBLIC_SENTRY_DSN=\$SENTRY_DSN\b/);
  assert.match(section, /\bENV EXPO_PUBLIC_SENTRY_RELEASE=\$SENTRY_RELEASE\b/);
  assert.match(section, /\bENV EXPO_UNSTABLE_WEB_MODAL=1\b/);
  assert.doesNotMatch(section, /\bENV EXPO_PUBLIC_POSTHOG_API_KEY=\$POSTHOG_API_KEY\b/);

  assert.doesNotMatch(section, /\bSENTRY_AUTH_TOKEN\b/);
  assert.doesNotMatch(section, /\bsentry-expo-upload-sourcemaps\b/);
  assert.doesNotMatch(section, /--mount=type=secret/);
  assert.match(section, /precompress-ui-web-assets\.mjs --dir apps\/ui\/dist --gzip-only/);
  assert.match(webappSection, /gzip_static on/);
  assert.match(webappSection, /gzip_vary on/);
});
