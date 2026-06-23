namespace application.Services;

/// <summary>
/// In-memory store of cross-module function DEFINITIONS as a raw JSON array (the same shape the
/// System view authors and `deploy_cross_module` accepts). Lets MCP-deployed cross-module functions
/// surface in the UI: the System view fetches this on mount and imports any it doesn't already have.
/// Project-scoped — cleared when a project is created/opened so defs don't leak between projects.
/// </summary>
public sealed class CrossModuleStore
{
    private readonly object _lock = new();
    private string _json = "[]";

    public string Get() { lock (_lock) return _json; }

    public void Set(string? json)
    {
        lock (_lock) _json = string.IsNullOrWhiteSpace(json) ? "[]" : json!;
    }

    public void Clear() { lock (_lock) _json = "[]"; }
}
