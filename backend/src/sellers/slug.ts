// Builds a link-safe slug from a business name:
//   "Mama T's Kitchen" -> "mama-ts-kitchen",  "Ìyá Basira" -> "iya-basira"
const MAX_LENGTH = 40;
const MIN_LENGTH = 3;
// Room for a "-NN" suffix when the plain slug is taken.
const BASE_MAX_LENGTH = MAX_LENGTH - 3;

export function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents: "Iyá" -> "Iya"
    .toLowerCase()
    .replace(/['’]/g, '') // "T's" -> "ts", not "t-s"
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, BASE_MAX_LENGTH)
    .replace(/-+$/, ''); // the cut may leave a trailing hyphen

  if (base.length >= MIN_LENGTH) return base;
  return base ? `${base}-kitchen` : 'kitchen';
}

// The slugs to try in order: "mama-ts-kitchen", "mama-ts-kitchen-2", ...
export function slugCandidates(name: string, count: number): string[] {
  const base = slugify(name);
  return [base, ...Array.from({ length: count - 1 }, (_, i) => `${base}-${i + 2}`)];
}
