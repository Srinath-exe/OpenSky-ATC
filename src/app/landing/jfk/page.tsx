import type { Metadata } from 'next';
import LandingJfk from './LandingJfk';

// The first cut (JFK, 2026-11-09), kept as it was.
export const metadata: Metadata = { title: 'Air traffic control at JFK (first cut)', robots: { index: false } };

export default function LandingJfkPage() {
  return <LandingJfk />;
}
