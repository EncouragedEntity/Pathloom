/** App icon (variant 7, same drawing as src-tauri/icons/source.svg) for the logo in the UI. */
export function AppMark({ size = 20 }: { size?: number }) {
  return (
    <svg className="mk-svg" width={size} height={size} viewBox="0 0 1024 1024" aria-hidden="true">
      <rect width="1024" height="1024" rx="224" fill="#e8a33d" />
      <rect x="176" y="268" width="272" height="196" rx="44" fill="#23262b" />
      <rect x="576" y="560" width="272" height="196" rx="44" fill="#fff8ec" stroke="#23262b" strokeWidth="40" />
      <path d="M448 366 C 560 366, 464 658, 576 658" fill="none" stroke="#23262b" strokeWidth="44" strokeLinecap="round" />
      <rect x="236" y="342" width="120" height="28" rx="14" fill="#e8a33d" />
      <rect x="636" y="634" width="120" height="28" rx="14" fill="#23262b" />
    </svg>
  );
}
