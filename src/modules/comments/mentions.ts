// G3 / PDF §3.6: @mention extraction.
//
// Regex breakdown:
//   (?<![\w@])  — negative lookbehind: the @ MUST NOT be preceded by a word
//                  char or another @, so "jdoe@example.com" does NOT match
//                  "@example".
//   @           — literal @
//   ([a-zA-Z0-9_]+) — capture group: the username (matches User.username
//                  charset from CreateUserDto).
const MENTION_REGEX = /(?<![\w@])@([a-zA-Z0-9_]+)/g;

export function extractMentions(content: string): string[] {
  const out = new Set<string>();
  for (const m of content.matchAll(MENTION_REGEX)) {
    // Case-insensitive: store lowercase for diffing; resolver does LOWER()
    // lookups against User.username.
    out.add(m[1].toLowerCase());
  }
  return Array.from(out);
}
