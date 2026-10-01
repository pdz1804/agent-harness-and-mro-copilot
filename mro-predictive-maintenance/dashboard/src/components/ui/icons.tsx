import type { ReactNode } from "react";

/** One icon family: 24px grid, 1.8 stroke, round caps. Always decorative
 * (aria-hidden); the label next to it carries the meaning. */
function Svg({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const PlaneIcon = () => (
  <Svg>
    <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" />
  </Svg>
);
export const HomeIcon = () => (
  <Svg>
    <path d="M3 11 12 4l9 7" />
    <path d="M5 10v10h14V10" />
  </Svg>
);
export const WrenchIcon = () => (
  <Svg>
    <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z" />
  </Svg>
);
export const ChartIcon = () => (
  <Svg>
    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
  </Svg>
);
export const BookIcon = () => (
  <Svg>
    <path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z" />
    <path d="M4 19V5" />
  </Svg>
);
export const CheckCircleIcon = () => (
  <Svg>
    <circle cx="12" cy="12" r="9" />
    <path d="m8 12.5 2.8 2.8L16 9.5" />
  </Svg>
);
export const AlertTriangleIcon = () => (
  <Svg>
    <path d="M12 3 2.5 20h19z" />
    <path d="M12 10v4M12 17.2v.1" />
  </Svg>
);
export const OctagonIcon = () => (
  <Svg>
    <path d="M8 3h8l5 5v8l-5 5H8l-5-5V8z" />
    <path d="M9 9l6 6M15 9l-6 6" />
  </Svg>
);
export const InfoIcon = () => (
  <Svg>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 7.8v.1" />
  </Svg>
);
export const RingIcon = () => (
  <Svg>
    <circle cx="12" cy="12" r="7" />
  </Svg>
);
export const ChevronRightIcon = () => (
  <Svg>
    <path d="m9 6 6 6-6 6" />
  </Svg>
);
export const ArrowDownIcon = () => (
  <Svg>
    <path d="M12 5v14M6 13l6 6 6-6" />
  </Svg>
);
export const ArrowUpIcon = () => (
  <Svg>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </Svg>
);
export const SortIcon = () => (
  <Svg>
    <path d="m8 9 4-4 4 4M8 15l4 4 4-4" />
  </Svg>
);
export const SearchIcon = () => (
  <Svg>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Svg>
);
export const CloseIcon = () => (
  <Svg>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);
export const DownloadIcon = () => (
  <Svg>
    <path d="M12 4v11M7 11l5 5 5-5M5 20h14" />
  </Svg>
);
export const RefreshIcon = () => (
  <Svg>
    <path d="M20 11a8 8 0 0 0-14.5-4M4 4v4h4M4 13a8 8 0 0 0 14.5 4M20 20v-4h-4" />
  </Svg>
);
export const StopIcon = () => (
  <Svg>
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </Svg>
);
export const SendIcon = () => (
  <Svg>
    <path d="M5 12 20 5l-4 15-3.5-6.5z" />
  </Svg>
);
export const LockIcon = () => (
  <Svg>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Svg>
);
