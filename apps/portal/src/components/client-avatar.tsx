/** Colour pairs built only from the design tokens, each readable in light and dark. */
const AVATAR_TINTS = [
  'bg-ink text-surface',
  'bg-accent text-on-accent',
  'bg-success text-surface',
  'bg-warning text-surface',
  'bg-danger text-surface',
  'bg-muted text-surface',
];

/** A small hash of the id, so a client always gets the same colour. */
function tintFor(identifier: string): string {
  let hash = 0;
  for (const character of identifier) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return AVATAR_TINTS[hash % AVATAR_TINTS.length] as string;
}

/** The first letter of a client's name in a coloured circle: decoration beside the name, which is always written out. */
export function ClientAvatar({ clientId, name, size = 'md' }: { clientId: string; name: string; size?: 'md' | 'lg' }) {
  const sizeClasses = size === 'lg' ? 'size-12 text-heading' : 'size-9 text-label';
  return (
    <span aria-hidden="true" className={`flex shrink-0 items-center justify-center rounded-pill font-display font-bold ${sizeClasses} ${tintFor(clientId)}`}>
      {[...name.trim()][0]?.toUpperCase() ?? '?'}
    </span>
  );
}
