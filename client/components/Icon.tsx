/** Line icons drawn on a 20×20 grid, in the same stroke style as the editor toolbar. */
const PATHS = {
  home: ['M3 9.2 10 3.5l7 5.7', 'M5 7.8V16h3.6v-4.4h2.8V16H15V7.8'],
  comment: ['M4 4.5h12a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1H9l-3.5 3v-3H4a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1Z'],
  history: ['M3.5 10a6.5 6.5 0 1 0 1.9-4.6', 'M3.5 3.5v3h3', 'M10 6.5V10l2.5 1.6'],
  download: ['M10 3.5v9', 'm6 9 4 4 4-4', 'M4 16.5h12'],
  more: ['M5 10h.01', 'M10 10h.01', 'M15 10h.01'],
  chevronDown: ['m6 8 4 4 4-4'],
  chevronRight: ['m8 5 5 5-5 5'],
  signOut: ['M8 4H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3', 'm12 6.5 3.5 3.5-3.5 3.5', 'M15.5 10H8'],
  file: ['M5.5 2.5h6L15 6v10.5a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1Z', 'M11 2.5V6.5h4', 'M7.5 10h5', 'M7.5 13h5'],
  search: ['M9 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z', 'm13.5 13.5 3.5 3.5'],
  plus: ['M10 4v12', 'M4 10h12'],
  upload: ['M10 13V4', 'M6 7.5 10 3.5l4 4', 'M4 16.5h12'],
  check: ['m4.5 10.5 3.5 3.5 7.5-8'],
  trash: ['M4 6h12', 'M8 6V4.5h4V6', 'M5.5 6l.8 10a1 1 0 0 0 1 .9h5.4a1 1 0 0 0 1-.9l.8-10'],
  share: ['M7 10.5 13 7', 'M7 9.5l6 3.5', 'M14.5 7.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z', 'M5.5 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z', 'M14.5 16.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z'],
  close: ['m5.5 5.5 9 9', 'm14.5 5.5-9 9'],
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  const thick = name === 'more';
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={thick ? 3 : 1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
