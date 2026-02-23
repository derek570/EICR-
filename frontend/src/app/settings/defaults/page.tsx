"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Save, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, User, UserDefaults, FieldSchema, FieldDefinition } from "@/lib/api";

export default function DefaultsPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [defaults, setDefaults] = useState<UserDefaults>({});
  const [schema, setSchema] = useState<FieldSchema | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const storedUser = localStorage.getItem("user");
    if (!storedUser) {
      router.push("/login");
      return;
    }

    const userData = JSON.parse(storedUser) as User;
    setUser(userData);

    async function loadData() {
      try {
        const [userDefaults, fieldSchema] = await Promise.all([
          api.getUserDefaults(userData.id),
          api.getFieldSchema(),
        ]);
        setDefaults(userDefaults);
        setSchema(fieldSchema);
      } catch (error) {
        console.error("Failed to load defaults:", error);
        toast.error("Failed to load settings");
      } finally {
        setLoading(false);
      }
    }

    loadData();
  }, [router]);

  const handleSave = async () => {
    if (!user) return;

    setSaving(true);
    try {
      await api.saveUserDefaults(user.id, defaults);
      toast.success("Defaults saved");
    } catch (error) {
      console.error("Failed to save defaults:", error);
      toast.error("Failed to save defaults");
    } finally {
      setSaving(false);
    }
  };

  const handleChange = (field: string, value: string) => {
    setDefaults((prev) => ({
      ...prev,
      [field]: value,
    }));
  };

  const handleReset = () => {
    setDefaults({});
    toast.info("Defaults cleared (save to apply)");
  };

  if (loading || !schema) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Group fields by their group
  const fieldsByGroup = new Map<string, Array<{ key: string; def: FieldDefinition }>>();

  Object.entries(schema.circuit_fields).forEach(([key, def]) => {
    const group = def.group || "Other";
    if (!fieldsByGroup.has(group)) {
      fieldsByGroup.set(group, []);
    }
    fieldsByGroup.get(group)!.push({ key, def });
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Circuit Defaults</h1>
          <p className="text-sm text-muted-foreground">
            Set default values for new circuits. Use &quot;Apply Defaults&quot; in the circuit editor.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleReset}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Clear All
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            Save
          </Button>
        </div>
      </div>

      {schema.field_groups.map((group) => {
        const fields = fieldsByGroup.get(group.name) || [];
        if (fields.length === 0) return null;

        return (
          <Card key={group.name}>
            <CardHeader>
              <CardTitle>{group.name}</CardTitle>
              <CardDescription>
                Default values for {group.name.toLowerCase()} fields
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {fields.map(({ key, def }) => (
                  <div key={key} className="space-y-2">
                    <Label htmlFor={key}>{def.label}</Label>
                    {def.type === "select" && def.options ? (
                      <Select
                        value={defaults[key] || ""}
                        onValueChange={(value) => handleChange(key, value)}
                      >
                        <SelectTrigger id={key}>
                          <SelectValue placeholder="Select..." />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="">None</SelectItem>
                          {def.options.map((opt) => (
                            <SelectItem key={opt} value={opt}>
                              {opt}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        id={key}
                        value={defaults[key] || ""}
                        onChange={(e) => handleChange(key, e.target.value)}
                        placeholder={def.default || ""}
                      />
                    )}
                    <p className="text-xs text-muted-foreground">{def.description}</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
