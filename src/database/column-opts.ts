// Centralized TypeORM column-option presets.
// D10: every @CreateDateColumn / @UpdateDateColumn / @DeleteDateColumn / @Column-of-date-type
// MUST use TIMESTAMPTZ_COLUMN_OPTS. TypeORM's default is `timestamp without time zone`,
// which silently drifts across server timezones.
export const TIMESTAMPTZ_COLUMN_OPTS = {
  type: 'timestamptz' as const,
};
