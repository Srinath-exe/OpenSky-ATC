import './globals.css'
export const metadata = {
  title: 'SkyControl - ATC Simulation',
  description: 'Ground & Tower ATC Simulation with interactive airport maps',
}
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen w-full bg-slate-950 text-slate-100">{children}</body>
    </html>
  )
}
