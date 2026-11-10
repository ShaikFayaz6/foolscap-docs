import type { LivePeer } from '../../shared/api.ts';
import { firstName } from '../lib/format.ts';

const COLORS = ['#7a3b8f', '#1f7a6d', '#b4541a', '#2f5fa8', '#a12f5a', '#5c6b1e'];
const MAX_SHOWN = 4;

export function peerColor(userId: string): string {
  let hash = 0;
  for (const char of userId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length]!;
}

/** One entry per person, however many tabs they have open. */
export function otherPeople(peers: LivePeer[], selfId: string | undefined): LivePeer[] {
  const people = new Map<string, LivePeer>();
  for (const peer of peers) {
    if (peer.userId !== selfId && !people.has(peer.userId)) people.set(peer.userId, peer);
  }
  return [...people.values()];
}

export function PeopleHere({ people, reconnecting }: { people: LivePeer[]; reconnecting: boolean }) {
  if (reconnecting) {
    return (
      <span className="live-state" role="status">
        Reconnecting…
      </span>
    );
  }
  if (people.length === 0) return null;
  const names = people.map((person) => firstName(person.name)).join(', ');
  const hidden = people.length - MAX_SHOWN;
  return (
    <span className="people-here" role="status" aria-label={`Also here: ${names}`} title={`Also here: ${names}`}>
      {people.slice(0, MAX_SHOWN).map((person) => (
        <span key={person.userId} className="person" style={{ background: peerColor(person.userId) }} aria-hidden="true">
          {firstName(person.name).charAt(0)}
        </span>
      ))}
      {hidden > 0 && (
        <span className="person person-more" aria-hidden="true">
          +{hidden}
        </span>
      )}
    </span>
  );
}
