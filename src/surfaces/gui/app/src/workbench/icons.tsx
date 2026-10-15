import {
  ArrowDown, ArrowLeft, ArrowUp, ChevronDown, CircleCheck, Copy, Ellipsis, ExternalLink,
  FileText, Folder, GitBranch, Globe, Maximize2, MessageSquare, Monitor, PanelLeft, PanelRight,
  Pin, Plus, Search, Settings, Square, Terminal, Users, X, type LucideProps,
} from 'lucide-react';

// Shared presentation only; every glyph comes from Lucide's named icon exports.
const ICON_PROPS = { size: 16, strokeWidth: 1.8, 'aria-hidden': true, focusable: false } as const;

export function FolderIcon(props: LucideProps) { return <Folder {...ICON_PROPS} {...props} />; }
export function SearchIcon(props: LucideProps) { return <Search {...ICON_PROPS} {...props} />; }
export function PlusIcon(props: LucideProps) { return <Plus {...ICON_PROPS} {...props} />; }
export function GearIcon(props: LucideProps) { return <Settings {...ICON_PROPS} {...props} />; }
export function ChevronIcon(props: LucideProps) { return <ChevronDown {...ICON_PROPS} {...props} />; }
export function PanelIcon(props: LucideProps) { return <PanelRight {...ICON_PROPS} {...props} />; }
export function RailIcon(props: LucideProps) { return <PanelLeft {...ICON_PROPS} {...props} />; }
export function CopyIcon(props: LucideProps) { return <Copy {...ICON_PROPS} {...props} />; }
export function BranchIcon(props: LucideProps) { return <GitBranch {...ICON_PROPS} {...props} />; }
export function ArrowDownIcon(props: LucideProps) { return <ArrowDown {...ICON_PROPS} {...props} />; }
export function ArrowUpIcon(props: LucideProps) { return <ArrowUp {...ICON_PROPS} {...props} />; }
export function ArrowLeftIcon(props: LucideProps) { return <ArrowLeft {...ICON_PROPS} {...props} />; }
export function StopIcon(props: LucideProps) { return <Square {...ICON_PROPS} {...props} />; }
export function TerminalIcon(props: LucideProps) { return <Terminal {...ICON_PROPS} {...props} />; }
export function CloseIcon(props: LucideProps) { return <X {...ICON_PROPS} {...props} />; }
export function ExpandIcon(props: LucideProps) { return <Maximize2 {...ICON_PROPS} {...props} />; }
export function CheckIcon(props: LucideProps) { return <CircleCheck {...ICON_PROPS} {...props} />; }
export function DocumentIcon(props: LucideProps) { return <FileText {...ICON_PROPS} {...props} />; }
export function TeamIcon(props: LucideProps) { return <Users {...ICON_PROPS} {...props} />; }
export function GlobeIcon(props: LucideProps) { return <Globe {...ICON_PROPS} {...props} />; }
export function MonitorIcon(props: LucideProps) { return <Monitor {...ICON_PROPS} {...props} />; }
export function ChatIcon(props: LucideProps) { return <MessageSquare {...ICON_PROPS} {...props} />; }
export function EllipsisIcon(props: LucideProps) { return <Ellipsis {...ICON_PROPS} {...props} />; }
export function PinIcon(props: LucideProps) { return <Pin {...ICON_PROPS} {...props} />; }
export function ExternalLinkIcon(props: LucideProps) { return <ExternalLink {...ICON_PROPS} {...props} />; }
