'use client';

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
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
import {
  GlassCard,
  GlassCardContent,
  GlassCardHeader,
  GlassCardTitle,
} from '@/components/ui/glass-card';
import { api } from '@/lib/api-client';
import type { User, Client, CreateClientData } from '@/lib/types';

function ClientAvatar({ name }: { name: string }) {
  const initials = name
    .split(' ')
    .map((n) => n[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <div
      className="flex items-center justify-center h-10 w-10 rounded-full shrink-0"
      style={{ background: 'linear-gradient(135deg, var(--brand-blue), var(--brand-green))' }}
    >
      <span className="text-sm font-bold text-white">{initials}</span>
    </div>
  );
}

export default function ClientsPage() {
  const router = useRouter();
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
    if (!storedUser) {
      setLoading(false);
      router.push('/login');
      return;
    }

    let userData: User;
    try {
      userData = JSON.parse(storedUser) as User;
    } catch {
      setLoading(false);
      router.push('/login');
      return;
    }
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
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-brand-blue" />
          <h1 className="text-lg font-semibold text-foreground">Clients</h1>
          <span className="text-sm text-muted-foreground">({clients.length})</span>
        </div>
        <Button onClick={() => setShowAddForm(true)} size="sm">
          <UserPlus className="h-4 w-4 mr-2" />
          Add Client
        </Button>
      </div>

      {/* Search */}
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search by name, email, phone, company..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-10"
        />
      </div>

      {/* Add Client Form */}
      {showAddForm && (
        <GlassCard gradientBorder>
          <GlassCardHeader>
            <GlassCardTitle className="text-base">Add New Client</GlassCardTitle>
          </GlassCardHeader>
          <GlassCardContent className="space-y-4">
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
          </GlassCardContent>
        </GlassCard>
      )}

      {/* Client List */}
      {filteredClients.length === 0 ? (
        <GlassCard>
          <GlassCardContent className="flex flex-col items-center justify-center py-12">
            <Users className="h-12 w-12 text-muted-foreground/30 mb-4" />
            <p className="text-lg font-semibold text-foreground mb-2">
              {search ? 'No matching clients' : 'No clients yet'}
            </p>
            <p className="text-sm text-muted-foreground text-center mb-4">
              {search
                ? 'Try a different search term.'
                : 'Add your first client to start building your CRM.'}
            </p>
            {!search && (
              <Button onClick={() => setShowAddForm(true)}>
                <UserPlus className="h-4 w-4 mr-2" />
                Add Client
              </Button>
            )}
          </GlassCardContent>
        </GlassCard>
      ) : (
        <div className="space-y-3 stagger-in">
          {filteredClients.map((client) => (
            <Link key={client.id} href={`/clients/${client.id}`}>
              <div className="animate-stagger-in glass-card p-4 transition-all duration-200 hover:-translate-y-0.5 hover:bg-white/8 hover:shadow-medium cursor-pointer mb-3">
                <div className="flex items-center gap-4">
                  <ClientAvatar name={client.name} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-semibold text-foreground truncate">{client.name}</p>
                        {client.company && (
                          <p className="flex items-center gap-1 text-sm text-muted-foreground mt-0.5">
                            <Building2 className="h-3 w-3 shrink-0" />
                            <span className="truncate">{client.company}</span>
                          </p>
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-11 w-11 p-0 text-muted-foreground hover:text-status-red hover:bg-status-red/10 shrink-0"
                        onClick={(e) => handleDeleteClient(e, client.id, client.name)}
                        disabled={deletingId === client.id}
                        aria-label={`Delete client ${client.name}`}
                      >
                        {deletingId === client.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                    <div className="flex items-center gap-4 mt-2">
                      {client.email && (
                        <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                          <Mail className="h-3 w-3 shrink-0" />
                          <span className="truncate">{client.email}</span>
                        </span>
                      )}
                      {client.phone && (
                        <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                          <Phone className="h-3 w-3 shrink-0" />
                          <span>{client.phone}</span>
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
