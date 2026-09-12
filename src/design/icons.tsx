'use client'
/* SKYCONTROL iconography (01 A6). Lucide line icons at strokeWidth 1.5 (absolute), plus custom ATC glyphs.
   Never use Unicode/emoji glyphs in the UI; use <Icon name=... size=... /> or the named exports below. */
import * as React from 'react'
import type { LucideIcon, LucideProps } from 'lucide-react'
import {
  ArrowUpRight, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, X, Search, RadioTower, Headphones, Bell, Settings2, House,
  CircleCheck, TriangleAlert, GitCompareArrows, PlaneLanding, PlaneTakeoff, Siren, Wind, Sparkles, Clock, Plus, Minus,
  LocateFixed, Map as MapIcon, Plane, Navigation, Volume2, VolumeX, Pause, Play, ArrowUp, ArrowDown, ArrowLeft, ArrowRight,
  RotateCcw, RotateCw, CornerDownLeft, Undo2, MousePointerClick, Terminal, Check, Info, CircleAlert, Wifi, Radio, Gauge, Layers,
  Eye, EyeOff, Circle, Square, Zap, Timer, Thermometer, CloudFog, Droplets, MapPin, Move, Crosshair, Compass, Copy, Trash2, Filter,
  ListFilter, Menu, MoreHorizontal, Loader, HelpCircle, ExternalLink, Users, Building2, Route, Fuel as FuelIcon, Snowflake, Ambulance as AmbulanceIcon,
} from 'lucide-react'

export const ICON_STROKE = 1.5

/** A6 name map: meaning -> Lucide component. Sizes are the spec defaults per context. */
export const ICONS = {
  'arrow-up-right': ArrowUpRight,   // open detail, 18
  'chevron-up': ChevronUp,          // expand/collapse, 16
  'chevron-down': ChevronDown,      // collapse / dropdown pill (14)
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  x: X,                             // close, 16
  search: Search,                   // 20
  'radio-tower': RadioTower,        // ADS-B feed, 20
  headphones: Headphones,           // radio / PTT, 20
  bell: Bell,                       // alerts, 20
  'settings-2': Settings2,          // settings, 20
  house: House,                     // home, 20
  'circle-check': CircleCheck,      // under control (stat), 20
  'triangle-alert': TriangleAlert,  // conflicts (stat), 20
  'git-compare-arrows': GitCompareArrows, // group: separation, 18
  'plane-landing': PlaneLanding,    // group: runway / arrival, 18 / 16
  'plane-takeoff': PlaneTakeoff,    // departure, 16
  siren: Siren,                     // group: emergency, 18
  wind: Wind,                       // group: wake, 18
  sparkles: Sparkles,               // recommend, 18
  clock: Clock,                     // late (table), 14
  plus: Plus,                       // zoom in, 18
  minus: Minus,                     // zoom out, 18
  'locate-fixed': LocateFixed,      // recentre, 18
  map: MapIcon,                     // layers, 18
  plane: Plane,                     // selected aircraft pill, 18
  navigation: Navigation,           // puck / heading (rotated), 22
  'volume-2': Volume2,              // voice on, 20
  'volume-x': VolumeX,              // voice off, 20
  pause: Pause,                     // 16
  play: Play,                       // 16
  'arrow-up': ArrowUp,              // step alt/spd up, 14
  'arrow-down': ArrowDown,          // step alt/spd down, 14
  'arrow-left': ArrowLeft,          // mobile back, 22
  'arrow-right': ArrowRight,
  'rotate-ccw': RotateCcw,          // step hdg left, 14
  'rotate-cw': RotateCw,            // step hdg right, 14
  'corner-down-left': CornerDownLeft, // send command, 16
  'undo-2': Undo2,                  // go around, 16
  'mouse-pointer-click': MousePointerClick, // empty detail panel, 24
  terminal: Terminal,               // command line prefix, 16
  check: Check,                     // menu selected, 16
  info: Info,                       // toast info, 18
  'circle-alert': CircleAlert,      // toast error, 18
  wifi: Wifi,
  radio: Radio,
  gauge: Gauge,
  layers: Layers,
  eye: Eye,
  'eye-off': EyeOff,
  circle: Circle,
  square: Square,
  zap: Zap,
  timer: Timer,
  thermometer: Thermometer,
  'cloud-fog': CloudFog,
  droplets: Droplets,
  'map-pin': MapPin,
  move: Move,
  crosshair: Crosshair,
  compass: Compass,
  copy: Copy,
  'trash-2': Trash2,
  filter: Filter,
  'list-filter': ListFilter,
  menu: Menu,
  'more-horizontal': MoreHorizontal,
  loader: Loader,
  'help-circle': HelpCircle,
  'external-link': ExternalLink,
  users: Users,
  'building-2': Building2,
  route: Route,
  fuel: FuelIcon,
  snowflake: Snowflake,
  ambulance: AmbulanceIcon,
} as const satisfies Record<string, LucideIcon>

export type IconName = keyof typeof ICONS

export interface IconProps extends Omit<LucideProps, 'ref' | 'size' | 'strokeWidth'> {
  name: IconName
  /** px; default 20 */
  size?: number
  /** override only for the filled stat glyphs (A6 allows 2px on the 12px check / "!") */
  strokeWidth?: number
  testId?: string
}

/** Single wrapper enforcing strokeWidth 1.5 + absoluteStrokeWidth (A23). */
export const Icon = React.forwardRef<SVGSVGElement, IconProps>(function Icon(
  { name, size = 20, strokeWidth = ICON_STROKE, testId, ...rest },
  ref,
) {
  const Cmp = ICONS[name]
  return <Cmp ref={ref} size={size} strokeWidth={strokeWidth} absoluteStrokeWidth aria-hidden={rest['aria-label'] ? undefined : true} data-testid={testId} {...rest} />
})

/* Tree-shaken named re-exports with the spec stroke bound in. */
function bind(Cmp: LucideIcon, defaultSize: number, displayName: string) {
  const B = React.forwardRef<SVGSVGElement, Omit<LucideProps, 'ref'>>(function Bound(props, ref) {
    return <Cmp ref={ref} size={defaultSize} strokeWidth={ICON_STROKE} absoluteStrokeWidth aria-hidden={props['aria-label'] ? undefined : true} {...props} />
  })
  B.displayName = displayName
  return B
}

export const IconArrowUpRight = bind(ArrowUpRight, 18, 'IconArrowUpRight')
export const IconChevronUp = bind(ChevronUp, 16, 'IconChevronUp')
export const IconChevronDown = bind(ChevronDown, 16, 'IconChevronDown')
export const IconChevronLeft = bind(ChevronLeft, 16, 'IconChevronLeft')
export const IconChevronRight = bind(ChevronRight, 16, 'IconChevronRight')
export const IconX = bind(X, 16, 'IconX')
export const IconSearch = bind(Search, 20, 'IconSearch')
export const IconRadioTower = bind(RadioTower, 20, 'IconRadioTower')
export const IconHeadphones = bind(Headphones, 20, 'IconHeadphones')
export const IconBell = bind(Bell, 20, 'IconBell')
export const IconSettings = bind(Settings2, 20, 'IconSettings')
export const IconHouse = bind(House, 20, 'IconHouse')
export const IconCircleCheck = bind(CircleCheck, 20, 'IconCircleCheck')
export const IconTriangleAlert = bind(TriangleAlert, 20, 'IconTriangleAlert')
export const IconSeparation = bind(GitCompareArrows, 18, 'IconSeparation')
export const IconPlaneLanding = bind(PlaneLanding, 18, 'IconPlaneLanding')
export const IconPlaneTakeoff = bind(PlaneTakeoff, 16, 'IconPlaneTakeoff')
export const IconSiren = bind(Siren, 18, 'IconSiren')
export const IconWind = bind(Wind, 18, 'IconWind')
export const IconSparkles = bind(Sparkles, 18, 'IconSparkles')
export const IconClock = bind(Clock, 14, 'IconClock')
export const IconPlus = bind(Plus, 18, 'IconPlus')
export const IconMinus = bind(Minus, 18, 'IconMinus')
export const IconLocate = bind(LocateFixed, 18, 'IconLocate')
export const IconMap = bind(MapIcon, 18, 'IconMap')
export const IconPlane = bind(Plane, 18, 'IconPlane')
export const IconNavigation = bind(Navigation, 22, 'IconNavigation')
export const IconVolumeOn = bind(Volume2, 20, 'IconVolumeOn')
export const IconVolumeOff = bind(VolumeX, 20, 'IconVolumeOff')
export const IconPause = bind(Pause, 16, 'IconPause')
export const IconPlay = bind(Play, 16, 'IconPlay')
export const IconArrowUp = bind(ArrowUp, 14, 'IconArrowUp')
export const IconArrowDown = bind(ArrowDown, 14, 'IconArrowDown')
export const IconArrowLeft = bind(ArrowLeft, 22, 'IconArrowLeft')
export const IconArrowRight = bind(ArrowRight, 16, 'IconArrowRight')
export const IconRotateCcw = bind(RotateCcw, 14, 'IconRotateCcw')
export const IconRotateCw = bind(RotateCw, 14, 'IconRotateCw')
export const IconSend = bind(CornerDownLeft, 16, 'IconSend')
export const IconGoAround = bind(Undo2, 16, 'IconGoAround')
export const IconPointerClick = bind(MousePointerClick, 24, 'IconPointerClick')
export const IconTerminal = bind(Terminal, 16, 'IconTerminal')
export const IconCheck = bind(Check, 16, 'IconCheck')
export const IconInfo = bind(Info, 18, 'IconInfo')
export const IconCircleAlert = bind(CircleAlert, 18, 'IconCircleAlert')
export const IconWifi = bind(Wifi, 16, 'IconWifi')
export const IconRadio = bind(Radio, 16, 'IconRadio')

/* ---------- Custom SVG glyphs (24 viewBox, 1.5px non-scaling strokes, round joins) ---------- */
export interface GlyphProps extends React.SVGProps<SVGSVGElement> {
  size?: number
  /** rotate in degrees (heading) */
  rotate?: number
  title?: string
  testId?: string
}

function Glyph({ size = 20, rotate, title, testId, children, style, ...rest }: GlyphProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      data-testid={testId}
      style={rotate !== undefined ? { ...style, transform: `rotate(${rotate}deg)` } : style}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  )
}
const NS = { vectorEffect: 'non-scaling-stroke' as const }

/** Plan-view airliner, nose up. */
export function AircraftTop(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path {...NS} d="M12 2.5c.9 0 1.5 1.2 1.5 3v4.2l8 4.3v2l-8-2v4.2l2.2 1.6v1.5L12 20.5l-3.7.8v-1.5l2.2-1.6V14l-8 2v-2l8-4.3V5.5c0-1.8.6-3 1.5-3z" />
    </Glyph>
  )
}
/** ARFF fire truck, side view. */
export function FireTruck(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path {...NS} d="M2.5 9.5h11v7h-11z" />
      <path {...NS} d="M13.5 11.5h4.2l3.8 3v2h-8z" />
      <path {...NS} d="M4 9.5V7h8v2.5" />
      <path {...NS} d="M9 5.5h5.5l2.5 2" />
      <circle {...NS} cx="6" cy="17.5" r="1.8" />
      <circle {...NS} cx="17" cy="17.5" r="1.8" />
      <path {...NS} d="M5 12h2M9 12h2" />
    </Glyph>
  )
}
/** Follow-me car with roof sign. */
export function FollowMeCar(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path {...NS} d="M3 13.5l1.6-4.2A1.5 1.5 0 0 1 6 8.3h9.5a1.5 1.5 0 0 1 1.4 1l1.6 4.2H21v3.2h-1.5" />
      <path {...NS} d="M3 13.5v3.2h1.5M7.5 16.7h9" />
      <circle {...NS} cx="6" cy="17" r="1.8" />
      <circle {...NS} cx="18" cy="17" r="1.8" />
      <path {...NS} d="M8 8.3V5.5h6v2.8" />
      <path {...NS} d="M4.5 11.5h13" />
    </Glyph>
  )
}
/** Pushback tug with towbar. */
export function Tug(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path {...NS} d="M3.5 15V10.5h6l1.5-3h4V15" />
      <path {...NS} d="M3.5 15h11.5" />
      <path {...NS} d="M15 12h6.5" />
      <path {...NS} d="M20 10.5v3" />
      <circle {...NS} cx="6.5" cy="16.8" r="1.8" />
      <circle {...NS} cx="12.5" cy="16.8" r="1.8" />
      <path {...NS} d="M5.5 10.5V8.5h3" />
    </Glyph>
  )
}
/** Ambulance, side view, with cross. */
export function Ambulance(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path {...NS} d="M2.5 8.5h11v8h-11z" />
      <path {...NS} d="M13.5 10.5h4l3.5 3.2v2.8h-7.5z" />
      <circle {...NS} cx="6" cy="17.3" r="1.8" />
      <circle {...NS} cx="17" cy="17.3" r="1.8" />
      <path {...NS} d="M8 10.5v4M6 12.5h4" />
      <path {...NS} d="M6.5 8.5V6.5h4v2" />
    </Glyph>
  )
}
/** Fuel bowser. */
export function Fuel(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect {...NS} x="2.5" y="9" width="12" height="7" rx="3.5" />
      <path {...NS} d="M14.5 11.5h3.5l3 2.5v2h-6.5" />
      <circle {...NS} cx="6" cy="17.3" r="1.8" />
      <circle {...NS} cx="17" cy="17.3" r="1.8" />
      <path {...NS} d="M6 9V6.5h4" />
      <path {...NS} d="M8.5 12.5h1" />
    </Glyph>
  )
}
/** De-icing rig with boom. */
export function Deice(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path {...NS} d="M2.5 11.5h9v5h-9z" />
      <path {...NS} d="M11.5 13h4l2.5 2v1.5h-6.5" />
      <circle {...NS} cx="5.5" cy="17.3" r="1.8" />
      <circle {...NS} cx="15.5" cy="17.3" r="1.8" />
      <path {...NS} d="M7 11.5L13 5h5" />
      <path {...NS} d="M18 5l1.5-1.5M18 5l1.5 1.5M18 5h2.5" />
      <path {...NS} d="M20.5 8.5v1M22 10.5v1M19 10.5v1" />
    </Glyph>
  )
}
/** Windsock on a mast. */
export function Windsock(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path {...NS} d="M4 21V3" />
      <path {...NS} d="M4 5h6l10 2.5v3L10 12H4z" />
      <path {...NS} d="M10 5v7M14 6v5M17.5 7v3.4" />
      <path {...NS} d="M2 21h4" />
    </Glyph>
  )
}

/** Logo mark: five diagonal rounded bars in a rounded square (A6). */
export function LogoMark({ size = 28, opacity = 1, testId, ...rest }: { size?: number; opacity?: number; testId?: string } & React.SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true" data-testid={testId} style={{ opacity, color: 'var(--text-1)' }} {...rest}>
      <defs>
        <clipPath id="ds-logo-clip"><rect x="0" y="0" width="28" height="28" rx="8" /></clipPath>
      </defs>
      <g clipPath="url(#ds-logo-clip)" stroke="currentColor" strokeWidth="3" strokeLinecap="round" transform="rotate(-45 14 14)">
        <line x1="14" y1="-4" x2="14" y2="32" transform="translate(-8 0)" />
        <line x1="14" y1="-4" x2="14" y2="32" transform="translate(-4 0)" />
        <line x1="14" y1="-4" x2="14" y2="32" />
        <line x1="14" y1="-4" x2="14" y2="32" transform="translate(4 0)" />
        <line x1="14" y1="-4" x2="14" y2="32" transform="translate(8 0)" />
      </g>
    </svg>
  )
}

export const VEHICLE_GLYPHS = {
  aircraft: AircraftTop,
  arff: FireTruck,
  'follow-me': FollowMeCar,
  tug: Tug,
  ambulance: Ambulance,
  fuel: Fuel,
  deice: Deice,
  windsock: Windsock,
} as const
export type VehicleGlyphName = keyof typeof VEHICLE_GLYPHS
