// Curated ECU CAN streams shipped with the app (2.10 of docs/competitor-research.md). Each `file` is a .dbc in
// ./ecu-dbc/ whose CM_ lines cite its public sources; `roles` names the signal that carries each engine value, so
// "Add an ECU from the library" can turn them into CAN inputs in one go. Only streams with one id per frame are
// here: a module's CAN input matches on the id alone and cannot pick a row of a multiplexed frame.
export const ROLES = [
  { key: 'rpm', label: 'Engine speed (RPM)' },
  { key: 'coolant', label: 'Coolant temperature' },
  { key: 'oil', label: 'Oil pressure' },
]

export const ECU_TEMPLATES = [
  { key: 'haltech', name: 'Haltech Elite / Nexus', file: 'haltech.dbc', note: 'Haltech ECU broadcast protocol, ids 0x360 to 0x3E0.',
    roles: { rpm: ['RPM', 'rpm'], coolant: ['Coolant_Temperature', '°C'], oil: ['Oil_Pressure', 'kPa'] } },
  { key: 'speeduino', name: 'Speeduino (Haltech broadcast)', file: 'haltech.dbc', note: 'Set the CAN broadcast protocol to Haltech in TunerStudio. Speeduino sends the Haltech frames (only boards with CAN, e.g. Teensy or STM32).',
    roles: { rpm: ['RPM', 'rpm'], coolant: ['Coolant_Temperature', '°C'], oil: ['Oil_Pressure', 'kPa'] } },
  { key: 'rusefi', name: 'rusEFI (verbose broadcast)', file: 'rusefi.dbc', note: 'Turn on verbose CAN broadcast. Ids assume the default base 0x200.',
    roles: { rpm: ['RPM', 'rpm'], coolant: ['CoolantTemp', '°C'], oil: ['OilPress', 'kPa'] } },
  { key: 'emublack', name: 'ECUMaster EMU Black', file: 'emublack.dbc', note: 'Turn on "Send EMU stream over CAN-Bus". Ids assume the default base 0x600.',
    roles: { rpm: ['RPM', 'rpm'], coolant: ['CoolantTemp', '°C'], oil: ['OilPressure', 'bar'] } },
  { key: 'maxxecu', name: 'MaxxECU', file: 'maxxecu.dbc', note: 'Default CAN protocol 1.3 at 500 kbit/s. Oil pressure needs firmware 1.135 or newer.',
    roles: { rpm: ['RPM', 'rpm'], coolant: ['Coolant_Temp', '°C'], oil: ['Oil_Pressure', 'kPa'] } },
]
