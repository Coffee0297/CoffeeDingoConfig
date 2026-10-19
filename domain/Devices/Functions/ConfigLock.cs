using System.Text;
using System.Text.Json.Serialization;
using domain.Enums;
using domain.Models;

namespace domain.Devices.Functions;

// Config lock (upstream dingoFW feat/config-lock, param 0x0200, every board): a 32-bit password (sub 0, write-only:
// the module always reads it as 0) and a 32-character installer contact text (subs 1-8, 4 ASCII chars per u32,
// first char in the low byte). Set + Burn + Restart locks it: Read/Write/ReadAll/WriteAll/Bootloader then get
// [58, idxLo, idxHi, sub, refusedCmd] until Unlock (56) with the password; Factory reset (57, 'WIPE') wipes it all.
// The module never gives the password back, so the app keeps its own copy (in the project) and sends it on every
// WriteAll: one with 0 removes the lock.
public class ConfigLock
{
    [JsonIgnore] public const int BaseIndex = 0x0200;
    [JsonIgnore] public const int ContactChars = 32;

    // 0 = no password
    [JsonPropertyName("password")] public uint Password { get; set; }
    [JsonPropertyName("contact")] public string Contact { get => field; set => field = Clean(value); } = "";

    // Runtime: the module refused a request with Locked (58) and no Unlock / allowed request since.
    [JsonIgnore] public bool Locked { get; set; }

    /// <summary>Printable ASCII only (the firmware stores bytes), at most 32 chars.</summary>
    public static string Clean(string? s)
    {
        var t = new string((s ?? "").Where(c => c >= 0x20 && c < 0x7F).ToArray());
        return t.Length > ContactChars ? t[..ContactChars] : t;
    }

    /// <summary>Contact text → the 8 u32 words of subs 1-8 (first char in the low byte, zero padded).</summary>
    public static uint[] Pack(string text)
    {
        var b = new byte[ContactChars];
        Encoding.ASCII.GetBytes(Clean(text)).CopyTo(b, 0);
        return Enumerable.Range(0, 8).Select(i => BitConverter.ToUInt32(b, i * 4)).ToArray();
    }

    /// <summary>The 8 words back to text (stops at the first 0 byte).</summary>
    public static string Unpack(uint[] words)
    {
        var b = words.SelectMany(BitConverter.GetBytes).TakeWhile(x => x != 0).ToArray();
        return Clean(Encoding.ASCII.GetString(b));
    }

    public List<DeviceParameter> Params(string parent)
    {
        var list = new List<DeviceParameter>
        {
            // write-only: a read gives 0, which must not overwrite the app's copy (SetValue ignores it)
            new() { ParentName = parent, Name = "lock.password", Index = BaseIndex, SubIndex = 0, WriteOnly = true,
                GetValue = () => Password, SetValue = _ => { }, ValueType = typeof(uint), DefaultValue = 0u },
        };
        for (var k = 0; k < 8; k++)
        {
            var kk = k;
            list.Add(new() { ParentName = parent, Name = $"lock.contact[{kk}]", Index = BaseIndex, SubIndex = 1 + kk,
                GetValue = () => Pack(Contact)[kk],
                SetValue = v => { var w = Pack(Contact); w[kk] = Convert.ToUInt32(v); Contact = Unpack(w); },
                ValueType = typeof(uint), DefaultValue = 0u });
        }
        return list;
    }

    public static CanFrame UnlockFrame(int txId, uint password) =>
        new(txId, 8, [(byte)MessageCommand.Unlock, .. BitConverter.GetBytes(password), 0, 0, 0]);
    public static CanFrame FactoryResetFrame(int txId) =>
        new(txId, 8, [(byte)MessageCommand.FactoryReset, (byte)'W', (byte)'I', (byte)'P', (byte)'E', 0, 0, 0]);
    public static CanFrame RestartFrame(int txId) =>
        new(txId, 8, [(byte)MessageCommand.Restart, (byte)'R', (byte)'E', (byte)'S', (byte)'E', (byte)'T', 0, 0]);
}
