// The question types, drawn: an icon for each, as the builder's list and cards show them.

import {
  AlignLeft,
  Calculator,
  Calendar,
  CalendarClock,
  CircleDot,
  ChevronsUpDown,
  Clock,
  Gauge,
  Grid3x3,
  Hash,
  ListChecks,
  ListOrdered,
  Mail,
  Paperclip,
  Phone,
  SeparatorHorizontal,
  SlidersHorizontal,
  SquareCheckBig,
  Star,
  TextQuote,
  Type,
  type LucideIcon,
} from "lucide-react";
import type { Kind } from "./model";

const ICONS: Record<Kind, LucideIcon> = {
  short_text: Type,
  long_text: AlignLeft,
  email: Mail,
  phone: Phone,
  number: Hash,
  decimal: Calculator,
  date: Calendar,
  time: Clock,
  datetime: CalendarClock,
  select: CircleDot,
  multi_select: ListChecks,
  checkbox: SquareCheckBig,
  dropdown: ChevronsUpDown,
  rating: Star,
  nps: Gauge,
  likert: SlidersHorizontal,
  matrix: Grid3x3,
  ranking: ListOrdered,
  file: Paperclip,
  page_break: SeparatorHorizontal,
  statement: TextQuote,
};

export function KindIcon({ kind, size = 16 }: { kind: Kind; size?: number }) {
  const Icon = ICONS[kind];
  return <Icon size={size} aria-hidden="true" />;
}
