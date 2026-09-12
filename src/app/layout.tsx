import type { Metadata, Viewport } from 'next'
import { DM_Sans } from 'next/font/google'
import './globals.css'

/* A18: DM Sans variable (wght 100-1000 covers the 300/400/500 tokens) with the opsz axis; the metric fallback
   ("DM Sans Fallback") is declared in globals.css. next/font requires weight 'variable' when axes are requested. */
const dmSans = DM_Sans({
  subsets: ['latin'],
  weight: 'variable',
  axes: ['opsz'],
  display: 'swap',
  variable: '--font-dm-sans',
  adjustFontFallback: false,
  fallback: ['DM Sans Fallback', 'Outfit', 'Helvetica Neue', 'Arial', 'sans-serif'],
})

export const metadata: Metadata = {
  title: 'SKYCONTROL',
  description: 'Ground, Tower and Approach ATC simulation',
}

export const viewport: Viewport = {
  themeColor: '#0b0b0c',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={dmSans.variable}>
      <body>{children}</body>
    </html>
  )
}
