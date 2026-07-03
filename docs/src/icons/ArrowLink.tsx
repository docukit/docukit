export function ArrowLink(props: { className?: string }) {
  return (
    <svg
      width="8"
      height="8"
      viewBox="0 0 8 8"
      fill="none"
      aria-hidden="true"
      {...props}
    >
      <path
        d="M2.91667 0.75H7.25M7.25 0.75V5.08333M7.25 0.75L0.75 7.25"
        className="stroke-gray-400 transition-colors group-hover/option:stroke-gray-900 dark:stroke-gray-500 dark:group-hover/option:stroke-gray-100"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      ></path>
    </svg>
  );
}
