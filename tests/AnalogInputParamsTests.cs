using System.Text.Json;
using domain.Devices.Functions;
using Xunit;

namespace tests;

/// <summary>
/// A project load deserializes each analog input through its constructor and then replaces Switch/Rotary/Scale
/// with the objects from the file. The params written to the device must read those loaded objects, not the
/// constructor's defaults (that bug wrote every rotary switch to a CANBoard as disabled with no points).
/// </summary>
public class AnalogInputParamsTests
{
    [Fact]
    public void Params_FollowDeserializedSubObjects()
    {
        const string json = """
            {"number":1,"name":"Headlights","enabled":true,
             "switch":{"number":1,"name":"Headlights","enabled":true,"mode":0,"invert":false,"threshold":1234},
             "rotary":{"number":1,"name":"Headlights","enabled":true,"invert":false,"numPos":5,"tolerance":150,
                       "points":[500,1500,2500,3500,4500,0,0,0,0,0]},
             "scale":{"number":1,"name":"Headlights","enabled":false}}
            """;
        var ai = JsonSerializer.Deserialize<AnalogInput>(json)!;
        object Val(string name) => ai.Params.Single(p => p.Name == name).GetValue();

        Assert.Equal(true, Val("rotarySwitch[1].enabled"));
        Assert.Equal(5, Val("rotarySwitch[1].numpos"));
        Assert.Equal(150, Val("rotarySwitch[1].tolerance"));
        Assert.Equal(500 | (1500 << 16), Val("rotarySwitch[1].pointPair[0]"));
        Assert.Equal(1234, Val("analogSwitch[1].threshold"));

        // a device write (SetValue) must land in the loaded object too
        ai.Params.Single(p => p.Name == "rotarySwitch[1].tolerance").SetValue(300);
        Assert.Equal(300, ai.Rotary.Tolerance);
    }
}
