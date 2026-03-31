'use client';

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  Plus,
  Search,
  UserPlus,
  Trash2,
  Loader2,
  Phone,
  Mail,
  Building2,
  Users,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api-client';
import type { User, Client, CreateClientData } from '@/lib/types';

export default function ClientsPage() {
  const [user, setUser] = useState<User | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [newClient, setNewClient] = useState<CreateClientData>({
    name: '',
    email: '',
    phone: '',
    company: '',
    notes: '',
  });

  useEffect(() => {
    const storedUser = localStorage.getItem('user');
    if (!storedUser) return;

    const userData = JSON.parse(storedUser) as User;
    setUser(userData);

    async function loadClients() {
      try {
        const clientsList = await api.getClients(userData.id);
        setClients(clientsList);
      } catch (error) {
        console.error('Failed to load clients:', error);
        toast.error('Failed to load clients');
      } finally {
        setLoading(false);
      }
    }
    loadClients();
  }, []);

  const filteredClients = useMemo(() => {
    if (!search.trim()) return clients;
    const q = search.toLowerCase();
    return clients.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.email && c.email.toLowerCase().includes(q)) ||
        (c.phone && c.phone.includes(q)) ||
        (c.company && c.company.toLowerCase().includes(q))
    );
  }, [clients, search]);

  const handleAddClient = async () => {
    if (!user || !newClient.name.trim()) {
      toast.error('Client name is required');
      return;
    }

    setSaving(true);
    try {
      const created = await api.createClient(user.id, newClient);
      setClients((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      setNewClient({ name: '', email: '', phone: '', company: '', notes: '' });
      setShowAddForm(false);
      toast.success(`Client "${created.name}" created`);
    } catch (error) {
      console.error('Failed to create client:', error);
      toast.error('Failed to create client');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteClient = async (e: React.MouseEvent, clientId: string, clientName: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (!user) return;

    const confirmed = window.confirm(
      `Delete client "${clientName}"?\n\nThis will unlink their properties but not delete them.`
    );
    if (!confirmed) return;

    setDeletingId(clientId);
    try {
      await api.deleteClient(user.id, clientId);
      setClients((prev) => prev.filter((c) => c.id !== clientId));
      toast.success(`Client "${clientName}" deleted`);
    } catch (error) {
      console.error('Failed to delete client:', error);
      toast.error('Failed to delete client');
    } finally {
      setDeletingId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-[var(--brand-blue)]" />
          <h1 className="text-lg font-semibold">Clients</h1>
          <span className="text-sm text-gray-500">({clients.length})</span>
        </div>
        <Button onClick={() => setShowAddForm(true)} size="sm">
          <UserPlus className="h-4 w-4 mr-2" />
          Add Client
        </Button>
      </div>

      {/* Search */}
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <Input
          placeholder="Search by name, email, phone, company..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-10"
        />
      </div>

      {/* Add Client Form */}
      {showAddForm && (
        <Card className="border-[var(--brand-blue)]/30">
          <CardHeader>
            <CardTitle className="text-base">Add New Client</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="new-name">Name *</Label>
                <Input
                  id="new-name"
                  value={newClient.name}
                  onChange={(e) => setNewClient((prev) => ({ ...prev, name: e.target.value }))}
                  placeholder="Client full name"
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-company">Company</Label>
                <Input
                  id="new-company"
                  value={newClient.company || ''}
                  onChange={(e) => setNewClient((prev) => ({ ...prev, company: e.target.value }))}
                  placeholder="Company name"
                />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="new-email">Email</Label>
                <Input
                  id="new-email"
                  type="email"
                  value={newClient.email || ''}
                  onChange={(e) => setNewClient((prev) => ({ ...prev, email: e.target.value }))}
                  placeholder="client@example.com"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-phone">Phone</Label>
                <Input
                  id="new-phone"
                  type="tel"
                  value={newClient.phone || ''}
                  onChange={(e) => setNewClient((prev) => ({ ...prev, phone: e.target.value }))}
                  placeholder="07700 900000"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-notes">Notes</Label>
              <Textarea
                id="new-notes"
                value={newClient.notes || ''}
                onChange={(e) => setNewClient((prev) => ({ ...prev, notes: e.target.value }))}
                placeholder="Any notes about this client..."
                rows={2}
              />
            </div>
            <div className="flex gap-2 justify-end">
              <Button
                variant="outline"
                onClick={() => {
                  setShowAddForm(false);
                  setNewClient({ name: '', email: '', phone: '', company: '', notes: '' });
                }}
              >
                Cancel
              </Button>
              <Button onClick={handleAddClient} disabled={saving || !newClient.name.trim()}>
                {saving ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Plus className="h-4 w-4 mr-2" />
                    Add Client
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Client List */}
      {filteredClients.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Users className="h-12 w-12 text-gray-300 mb-4" />
            <CardTitle className="mb-2">
              {search ? 'No matching clients' : 'No clients yet'}
            </CardTitle>
            <CardDescription className="text-center mb-4">
              {search
                ? 'Try a different search term.'
                : 'Add your first client to start building your CRM.'}
            </CardDescription>
            {!search && (
              <Button onClick={() => setShowAddForm(true)}>
                <UserPlus className="h-4 w-4 mr-2" />
                Add Client
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {filteredClients.map((client) => (
            <Link key={client.id} href={`/clients/${client.id}`}>
              <Card className="hover:shadow-md transition-shadow cursor-pointer h-full">
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between">
                    <div className="min-w-0 flex-1">
                      <CardTitle className="text-base truncate">{client.name}</CardTitle>
                      {client.company && (
                        <CardDescription className="flex items-center gap-1 mt-1">
                          <Building2 className="h-3 w-3" />
                          {client.company}
                        </CardDescription>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0 text-gray-400 hover:text-red-600 hover:bg-red-50 flex-shrink-0"
                      onClick={(e) => handleDeleteClient(e, client.id, client.name)}
                      disabled={deletingId === client.id}
                    >
                      {deletingId === client.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="pt-0 space-y-1">
                  {client.email && (
                    <div className="flex items-center gap-2 text-sm text-gray-500">
                      <Mail className="h-3 w-3 flex-shrink-0" />
                      <span className="truncate">{client.email}</span>
                    </div>
                  )}
                  {client.phone && (
                    <div className="flex items-center gap-2 text-sm text-gray-500">
                      <Phone className="h-3 w-3 flex-shrink-0" />
                      <span>{client.phone}</span>
                    </div>
                  )}
                  <p className="text-xs text-gray-400 pt-1">
                    Added {new Date(client.created_at).toLocaleDateString()}
                  </p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
