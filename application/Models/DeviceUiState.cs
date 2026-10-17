namespace application.Models;

/// <summary>
/// Tracks UI-related state for devices (persists across navigation)
/// </summary>
public class DeviceUiState
{
    public bool NeedsRead { get; set; }

    // Progress of a chunked (one-param-at-a-time) Read All, surfaced to the UI.
    public bool Reading { get; set; }
    public int ReadDone { get; set; }
    public int ReadTotal { get; set; }

    // G3: null = nothing written this session; false = the module took a write it will lose at power-off;
    // true = a confirmed burn stored it. ponytail: the firmware reports no stored-image CRC, so a power cycle
    // (values lost) is not seen; add one to the burn reply / CheckCrc to make this exact.
    public bool? StoredOnModule { get; set; }
    // G9: the last bootloader scan found this module in OpenBLT (it answered XCP CONNECT on base+12/13).
    // Only meaningful while the module sends no status frames; it is reported as false once it does.
    public bool InBootloader { get; set; }
    // G2: edits saved to the project and held for "Apply to car" since the module was last in step: one row per
    // changed field (repeat edits merge, keeping the first "before"). Only meaningful while the module differs
    // (a confirmed write or read clears ConfigMismatch, and SyncEdits drops these with it). Lock on Edits.
    public List<PendingEdit> Edits { get; } = new();
    public int PendingEdits { get { lock (Edits) return Edits.Count; } }
    public void SyncEdits(Func<bool> mismatch) { lock (Edits) if (!mismatch()) Edits.Clear(); }   // read under the lock: an edit may be landing
    // Firmware 5.6
    public bool? HasLed { get; set; }               // Identify reply (G12)
    public bool Asleep { get; set; }                // announced "going to sleep" and quiet since (G14)
    public DateTime? AsleepSince { get; set; }
    public int? WakeReason { get; set; }            // SleepInfo: 0 power-on, 1 CAN, 2 digital input, 3 USB (G14)
    public int WakeSource { get; set; }             // the digital input number for 2
    public int WakeCount { get; set; }
    public int? SleepBlockers { get; set; }         // bit0 sleep off, bit1 outputs on, bit2 USB, bit3 CAN traffic
    public bool SleepInfoAsked { get; set; }        // asked once per connect
    // Sleep and wake log (5.6.3): one row per "going to sleep" goodbye and per wake report, newest last, 40 kept
    public List<SleepEvent> SleepLog { get; } = new();
    public bool WakeLogged { get; set; }            // this wake is in the log already
    public bool CheckAfterWake { get; set; }        // a config check skipped while it slept: run it when it talks again
    public void LogSleep(string kind, string why) { lock (SleepLog) { SleepLog.Add(new SleepEvent(DateTime.UtcNow, kind, why)); if (SleepLog.Count > 40) SleepLog.RemoveAt(0); } }
    public DateTime VersionAskedAt { get; set; }    // last automatic version request (unknown version)
}

/// <summary>One staged (not yet applied) field change. Kind/Number/Field address it for a revert: kind "output",
/// "device" or a FunctionMap kind; OldJson is the field's JSON before the first edit. Source: app (this UI,
/// X-Dingo-Stage), agent (MCP) or api (REST without the header, saved while the module was offline).</summary>
public record SleepEvent(DateTime At, string Kind, string Why);

public record PendingEdit(int Id, string Kind, int Number, string Field, string What, string Old, string New, string OldJson, string NewJson, string Source, DateTime At);
