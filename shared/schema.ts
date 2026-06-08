import { sqliteTable, text, real, integer } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const zones = sqliteTable("zones", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  lat: real("lat").notNull(),
  lng: real("lng").notNull(),
  type: text("type").notNull(),
  city: text("city").notNull().default("Lyon"),
});

export const profitabilityScores = sqliteTable("profitability_scores", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  zoneId: text("zone_id").notNull(),
  hour: integer("hour").notNull(),
  dayType: text("day_type").notNull(),
  demandScore: real("demand_score").notNull(),
  supplyScore: real("supply_score").notNull(),
  ratioDs: real("ratio_ds").notNull(),
  avgDistanceKm: real("avg_distance_km").notNull(),
  avgDurationMin: real("avg_duration_min").notNull(),
  avgFare: real("avg_fare").notNull(),
  profitabilityIndex: real("profitability_index").notNull(),
  longRideProbability: real("long_ride_probability").notNull(),
  surgeMultiplier: real("surge_multiplier").notNull().default(1.0),
});

export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  zoneId: text("zone_id").notNull(),
  eventType: text("event_type").notNull(),
  startTime: text("start_time").notNull(),
  endTime: text("end_time").notNull(),
  expectedAttendance: integer("expected_attendance"),
  demandBoost: real("demand_boost").notNull().default(1.0),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
});

export const rides = sqliteTable("rides", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  pickupZoneId: text("pickup_zone_id").notNull(),
  dropoffZoneId: text("dropoff_zone_id").notNull(),
  distanceKm: real("distance_km").notNull(),
  durationMin: real("duration_min").notNull(),
  fare: real("fare").notNull(),
  commission: real("commission").notNull(),
  fuelCost: real("fuel_cost").notNull(),
  netProfit: real("net_profit").notNull(),
  hourlyRate: real("hourly_rate").notNull(),
  isProfitable: integer("is_profitable", { mode: "boolean" }).notNull(),
  isLongRide: integer("is_long_ride", { mode: "boolean" }).notNull(),
  timestamp: text("timestamp").notNull(),
  weather: text("weather"),
});

export const alerts = sqliteTable("alerts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  zoneId: text("zone_id"),
  priority: text("priority").notNull(),
  estimatedRevenue: real("estimated_revenue"),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
  isRead: integer("is_read", { mode: "boolean" }).notNull().default(false),
});

export const driverProfile = sqliteTable("driver_profile", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fuelConsumptionPer100km: real("fuel_consumption_per100km").notNull().default(7.0),
  fuelPricePerLiter: real("fuel_price_per_liter").notNull().default(1.85),
  platformCommissionPct: real("platform_commission_pct").notNull().default(25.0),
  hourlyTargetIncome: real("hourly_target_income").notNull().default(30.0),
  wearCostPerKm: real("wear_cost_per_km").notNull().default(0.08),
  minProfitableKmPerMin: real("min_profitable_km_per_min").notNull().default(1.0),
  vehicleType: text("vehicle_type").notNull().default("berline"),
  preferLongRides: integer("prefer_long_rides", { mode: "boolean" }).notNull().default(true),
});

export const insertAlertSchema = createInsertSchema(alerts).omit({ id: true });
export const insertRideSchema = createInsertSchema(rides).omit({ id: true });
export const insertDriverProfileSchema = createInsertSchema(driverProfile).omit({ id: true });

export type Zone = typeof zones.$inferSelect;
export type ProfitabilityScore = typeof profitabilityScores.$inferSelect;
export type Event = typeof events.$inferSelect;
export type Ride = typeof rides.$inferSelect;
export type Alert = typeof alerts.$inferSelect;
export type DriverProfile = typeof driverProfile.$inferSelect;
export type InsertAlert = z.infer<typeof insertAlertSchema>;
export type InsertRide = z.infer<typeof insertRideSchema>;
export type InsertDriverProfile = z.infer<typeof insertDriverProfileSchema>;
