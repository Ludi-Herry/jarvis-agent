import type { SVGProps } from 'react';

/** Inline 16px stroke icons; no icon dependency and no decorative glyph. */
function Icon({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export function FolderIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M1.8 4.2c0-.7.6-1.3 1.3-1.3h3l1.5 1.8h5.3c.7 0 1.3.6 1.3 1.3v5.8c0 .7-.6 1.3-1.3 1.3H3.1c-.7 0-1.3-.6-1.3-1.3z" />
    </Icon>
  );
}

export function SearchIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <circle cx="7.2" cy="7.2" r="4.4" />
      <path d="M10.5 10.5 13.6 13.6" />
    </Icon>
  );
}

export function PlusIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M8 3.2v9.6M3.2 8h9.6" />
    </Icon>
  );
}

export function GearIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7 3.6 3.6" />
    </Icon>
  );
}

export function ChevronIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M4.4 6.2 8 9.8l3.6-3.6" />
    </Icon>
  );
}

export function PanelIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <rect x="1.8" y="3" width="12.4" height="10" rx="1.2" />
      <path d="M10 3v10" />
    </Icon>
  );
}

export function RailIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <rect x="1.8" y="3" width="12.4" height="10" rx="1.2" />
      <path d="M6 3v10" />
    </Icon>
  );
}

export function CopyIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <rect x="5.4" y="5.4" width="8" height="8" rx="1.1" />
      <path d="M10.6 3.2c0-.3-.3-.6-.6-.6H3.2c-.3 0-.6.3-.6.6v6.8c0 .3.3.6.6.6" />
    </Icon>
  );
}

export function BranchIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <circle cx="4" cy="3.4" r="1.6" />
      <circle cx="4" cy="12.6" r="1.6" />
      <circle cx="12" cy="5.6" r="1.6" />
      <path d="M4 5v6M4 8.4c0 2 1.8 2.6 3.6 2.8l2.6.3" />
    </Icon>
  );
}

export function ArrowDownIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M8 2.8v10M4.2 9.2 8 13l3.8-3.8" />
    </Icon>
  );
}

export function StopIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <rect x="3.6" y="3.6" width="8.8" height="8.8" rx="1.2" />
    </Icon>
  );
}

export function TerminalIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M2.6 4.4 5.8 8l-3.2 3.6M7.6 12h5.8" />
    </Icon>
  );
}
