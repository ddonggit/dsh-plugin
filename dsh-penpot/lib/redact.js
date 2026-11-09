const PATTERNS = [
  [/PENPOT_SECRET_KEY\s*[:=]\s*\S+/gi, 'PENPOT_SECRET_KEY=<redacted>'],
  [/PENPOT_DATABASE_PASSWORD\s*[:=]\s*\S+/gi, 'PENPOT_DATABASE_PASSWORD=<redacted>'],
  [/(Authorization\s*[:=]\s*)(?:Token|Bearer)\s+\S+/gi, '$1<redacted>'],
  [/([?&]userToken=)[^&\s]+/gi, '$1<redacted>'],
]

/** Remove secrets that may appear in compose logs or error messages. */
export function redact(text, secrets = []) {
  let out = String(text ?? '')
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) {
      out = out.split(secret).join('<redacted>')
    }
  }
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement)
  return out
}

/** Read the two known secret values from an env file body without logging them. */
export function secretsFromEnv(text) {
  const secrets = []
  for (const line of String(text ?? '').split('\n')) {
    const match = /^PENPOT_(?:SECRET_KEY|DATABASE_PASSWORD)=(.*)$/.exec(line.trim())
    if (match && match[1].length >= 8) secrets.push(match[1])
  }
  return secrets
}