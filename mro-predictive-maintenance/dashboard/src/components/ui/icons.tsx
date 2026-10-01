import type { LucideIcon, LucideProps } from "lucide-react";
import {
  Activity,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  BellRing,
  BookOpen,
  Bot,
  ChartNoAxesColumn,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  ClipboardList,
  CornerDownLeft,
  Download,
  FileText,
  Gauge,
  House,
  Inbox,
  Info,
  Lock,
  OctagonX,
  Plane,
  RefreshCw,
  Search,
  SendHorizontal,
  ShieldCheck,
  Square,
  TriangleAlert,
  Wrench,
  X,
} from "lucide-react";

/** One icon family: lucide, 1.75 stroke, round caps. Always decorative
 * (aria-hidden); the label next to it carries the meaning. Size comes from
 * the surrounding CSS so every context sets its own optical size. */
function wrap(Icon: LucideIcon) {
  const Wrapped = (props: LucideProps) => <Icon size="1em" strokeWidth={1.75} aria-hidden="true" focusable="false" {...props} />;
  Wrapped.displayName = Icon.displayName;
  return Wrapped;
}

export const PlaneIcon = wrap(Plane);
export const HomeIcon = wrap(House);
export const WrenchIcon = wrap(Wrench);
export const ChartIcon = wrap(ChartNoAxesColumn);
export const BookIcon = wrap(BookOpen);
export const CheckCircleIcon = wrap(CircleCheck);
export const AlertTriangleIcon = wrap(TriangleAlert);
export const OctagonIcon = wrap(OctagonX);
export const InfoIcon = wrap(Info);
export const RingIcon = wrap(CircleDashed);
export const ChevronRightIcon = wrap(ChevronRight);
export const ChevronDownIcon = wrap(ChevronDown);
export const ArrowDownIcon = wrap(ArrowDown);
export const ArrowUpIcon = wrap(ArrowUp);
export const ArrowRightIcon = wrap(ArrowRight);
export const SortIcon = wrap(ArrowUpDown);
export const SearchIcon = wrap(Search);
export const CloseIcon = wrap(X);
export const DownloadIcon = wrap(Download);
export const RefreshIcon = wrap(RefreshCw);
export const StopIcon = wrap(Square);
export const SendIcon = wrap(SendHorizontal);
export const LockIcon = wrap(Lock);
export const EnterIcon = wrap(CornerDownLeft);
export const BotIcon = wrap(Bot);
export const ActivityIcon = wrap(Activity);
export const BellIcon = wrap(BellRing);
export const ClipboardIcon = wrap(ClipboardList);
export const GaugeIcon = wrap(Gauge);
export const InboxIcon = wrap(Inbox);
export const FileIcon = wrap(FileText);
export const ShieldIcon = wrap(ShieldCheck);
export const CheckIcon = wrap(Check);
export const CircleAlertIcon = wrap(CircleAlert);
