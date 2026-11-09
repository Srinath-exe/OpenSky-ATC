import 'package:flutter/material.dart';

/// The game's tokens (dark-first, orange accent), so the native screens feel like the same product.
class AtcColors {
  static const bg = Color(0xFF0E0F11);
  static const surface = Color(0xFF141416);
  static const raise = Color(0xFF1C1C1E);
  static const line = Color(0x17FFFFFF);
  static const text = Color(0xFFF2F2F0);
  static const muted = Color(0xFF9A9A9E);
  static const accent = Color(0xFFF5933F);
  static const good = Color(0xFF57CD50);
  static const bad = Color(0xFFE5534B);
}

ThemeData atcTheme() {
  final base = ThemeData(brightness: Brightness.dark, useMaterial3: true, colorSchemeSeed: AtcColors.accent);
  return base.copyWith(
    scaffoldBackgroundColor: AtcColors.bg,
    colorScheme: base.colorScheme.copyWith(primary: AtcColors.accent, surface: AtcColors.surface, onPrimary: Colors.black),
    textTheme: base.textTheme.apply(bodyColor: AtcColors.text, displayColor: AtcColors.text),
  );
}
