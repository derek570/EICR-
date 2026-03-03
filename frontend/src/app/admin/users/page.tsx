'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import {
  Plus,
  Loader2,
  Lock,
  Unlock,
  Key,
  Copy,
  RefreshCw,
  UserPlus,
  Eye,
  EyeOff,
  ShieldCheck,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { api } from '@/lib/api';
import type { User, AdminUser } from '@/lib/api';

const createUserSchema = z.object({
  email: z.string().email('Please enter a valid email'),
  name: z.string().min(1, 'Name is required'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  company_name: z.string().optional(),
});

type CreateUserForm = z.infer<typeof createUserSchema>;

function generatePassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$';
  const array = new Uint8Array(14);
  crypto.getRandomValues(array);
  return Array.from(array)
    .map((b) => chars[b % chars.length])
    .join('');
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function isLocked(user: AdminUser): boolean {
  if (!user.locked_until) return false;
  return new Date(user.locked_until) > new Date();
}

export default function AdminUsersPage() {
  const router = useRouter();
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [togglingUserId, setTogglingUserId] = useState<string | null>(null);
  const [unlockingUserId, setUnlockingUserId] = useState<string | null>(null);

  // Password reset state
  const [resetUserId, setResetUserId] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [showResetPassword, setShowResetPassword] = useState(false);
  const [resetting, setResetting] = useState(false);

  const form = useForm<CreateUserForm>({
    resolver: zodResolver(createUserSchema),
    defaultValues: { email: '', name: '', password: '', company_name: '' },
  });

  useEffect(() => {
    const storedUser = localStorage.getItem('user');
    if (!storedUser) {
      router.push('/login');
      return;
    }
    const userData = JSON.parse(storedUser) as User;
    if (userData.role !== 'admin') {
      router.push('/dashboard');
      return;
    }
    setCurrentUser(userData);

    async function loadUsers() {
      try {
        const userList = await api.getAdminUsers();
        setUsers(userList);
      } catch (error) {
        console.error('Failed to load users:', error);
        toast.error('Failed to load users');
      } finally {
        setLoading(false);
      }
    }
    loadUsers();
  }, [router]);

  const refreshUsers = async () => {
    try {
      const userList = await api.getAdminUsers();
      setUsers(userList);
    } catch (error) {
      console.error('Failed to refresh users:', error);
      toast.error('Failed to refresh users');
    }
  };

  const onCreateUser = async (data: CreateUserForm) => {
    setCreating(true);
    try {
      const newUser = await api.createAdminUser(data);
      toast.success(`User created: ${newUser.email}`);
      setUsers((prev) => [newUser, ...prev]);
      form.reset();
      setShowCreateForm(false);
      setShowPassword(false);
    } catch (error) {
      console.error('Failed to create user:', error);
      const message = error instanceof Error ? error.message : 'Failed to create user';
      // Try to parse the API error message
      try {
        const parsed = JSON.parse(message);
        toast.error(parsed.error || message);
      } catch {
        toast.error(message);
      }
    } finally {
      setCreating(false);
    }
  };

  const handleToggleActive = async (user: AdminUser) => {
    if (user.id === currentUser?.id) {
      toast.error('Cannot deactivate your own account');
      return;
    }
    setTogglingUserId(user.id);
    try {
      await api.updateAdminUser(user.id, { is_active: !user.is_active });
      setUsers((prev) =>
        prev.map((u) => (u.id === user.id ? { ...u, is_active: !u.is_active } : u))
      );
      toast.success(user.is_active ? `${user.name} deactivated` : `${user.name} activated`);
    } catch (error) {
      console.error('Failed to toggle user:', error);
      toast.error('Failed to update user');
    } finally {
      setTogglingUserId(null);
    }
  };

  const handleUnlock = async (user: AdminUser) => {
    setUnlockingUserId(user.id);
    try {
      await api.unlockAdminUser(user.id);
      setUsers((prev) =>
        prev.map((u) =>
          u.id === user.id ? { ...u, failed_login_attempts: 0, locked_until: null } : u
        )
      );
      toast.success(`${user.name} unlocked`);
    } catch (error) {
      console.error('Failed to unlock user:', error);
      toast.error('Failed to unlock user');
    } finally {
      setUnlockingUserId(null);
    }
  };

  const handleResetPassword = async () => {
    if (!resetUserId || resetPassword.length < 8) return;
    setResetting(true);
    try {
      await api.resetAdminUserPassword(resetUserId, resetPassword);
      toast.success('Password reset successfully');
      setResetUserId(null);
      setResetPassword('');
      setShowResetPassword(false);
    } catch (error) {
      console.error('Failed to reset password:', error);
      toast.error('Failed to reset password');
    } finally {
      setResetting(false);
    }
  };

  const handleGeneratePassword = () => {
    const pw = generatePassword();
    form.setValue('password', pw);
    setShowPassword(true);
  };

  const handleCopyPassword = (pw: string) => {
    navigator.clipboard.writeText(pw).then(
      () => toast.success('Password copied to clipboard'),
      () => toast.error('Failed to copy password')
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Users</h1>
          <p className="text-sm text-muted-foreground">
            {users.length} user{users.length !== 1 ? 's' : ''} registered
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={refreshUsers}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
          <Button size="sm" onClick={() => setShowCreateForm(!showCreateForm)}>
            {showCreateForm ? (
              <>
                <X className="h-4 w-4 mr-2" />
                Cancel
              </>
            ) : (
              <>
                <UserPlus className="h-4 w-4 mr-2" />
                Add User
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Create User Form */}
      {showCreateForm && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Create New User</CardTitle>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onCreateUser)} className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Name</FormLabel>
                        <FormControl>
                          <Input placeholder="John Smith" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Email</FormLabel>
                        <FormControl>
                          <Input type="email" placeholder="john@example.com" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="company_name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Company (optional)</FormLabel>
                        <FormControl>
                          <Input placeholder="ABC Electrical Ltd" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="password"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Password</FormLabel>
                        <FormControl>
                          <div className="flex gap-2">
                            <div className="relative flex-1">
                              <Input
                                type={showPassword ? 'text' : 'password'}
                                placeholder="Min 8 characters"
                                {...field}
                              />
                              <button
                                type="button"
                                onClick={() => setShowPassword(!showPassword)}
                                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                              >
                                {showPassword ? (
                                  <EyeOff className="h-4 w-4" />
                                ) : (
                                  <Eye className="h-4 w-4" />
                                )}
                              </button>
                            </div>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={handleGeneratePassword}
                              title="Generate random password"
                            >
                              <RefreshCw className="h-4 w-4" />
                            </Button>
                            {field.value && (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => handleCopyPassword(field.value)}
                                title="Copy password"
                              >
                                <Copy className="h-4 w-4" />
                              </Button>
                            )}
                          </div>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setShowCreateForm(false);
                      form.reset();
                      setShowPassword(false);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={creating}>
                    {creating ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Creating...
                      </>
                    ) : (
                      <>
                        <Plus className="h-4 w-4 mr-2" />
                        Create User
                      </>
                    )}
                  </Button>
                </div>
              </form>
            </Form>
          </CardContent>
        </Card>
      )}

      {/* User List */}
      <div className="space-y-3">
        {users.map((user) => (
          <Card key={user.id} className={!user.is_active ? 'opacity-60' : undefined}>
            <CardContent className="py-4">
              <div className="flex items-start justify-between gap-4">
                {/* User info */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium truncate">{user.name}</span>
                    {user.role === 'admin' && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
                        <ShieldCheck className="h-3 w-3" />
                        Admin
                      </span>
                    )}
                    {!user.is_active && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
                        Inactive
                      </span>
                    )}
                    {isLocked(user) && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">
                        <Lock className="h-3 w-3" />
                        Locked
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground truncate">{user.email}</p>
                  <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground">
                    {user.company_name && <span>{user.company_name}</span>}
                    <span>Last login: {formatDate(user.last_login)}</span>
                    <span>Created: {formatDate(user.created_at)}</span>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 flex-shrink-0">
                  {isLocked(user) && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleUnlock(user)}
                      disabled={unlockingUserId === user.id}
                      title="Unlock account"
                    >
                      {unlockingUserId === user.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Unlock className="h-4 w-4" />
                      )}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setResetUserId(user.id);
                      setResetPassword('');
                      setShowResetPassword(false);
                    }}
                    title="Reset password"
                  >
                    <Key className="h-4 w-4" />
                  </Button>
                  {user.id !== currentUser?.id && (
                    <Button
                      variant={user.is_active ? 'outline' : 'default'}
                      size="sm"
                      onClick={() => handleToggleActive(user)}
                      disabled={togglingUserId === user.id}
                      title={user.is_active ? 'Deactivate user' : 'Activate user'}
                    >
                      {togglingUserId === user.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : user.is_active ? (
                        'Deactivate'
                      ) : (
                        'Activate'
                      )}
                    </Button>
                  )}
                </div>
              </div>

              {/* Password Reset Inline */}
              {resetUserId === user.id && (
                <div className="mt-3 pt-3 border-t flex items-end gap-2">
                  <div className="flex-1">
                    <Label className="text-xs">New Password</Label>
                    <div className="flex gap-2 mt-1">
                      <div className="relative flex-1">
                        <Input
                          type={showResetPassword ? 'text' : 'password'}
                          value={resetPassword}
                          onChange={(e) => setResetPassword(e.target.value)}
                          placeholder="Min 8 characters"
                        />
                        <button
                          type="button"
                          onClick={() => setShowResetPassword(!showResetPassword)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        >
                          {showResetPassword ? (
                            <EyeOff className="h-4 w-4" />
                          ) : (
                            <Eye className="h-4 w-4" />
                          )}
                        </button>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const pw = generatePassword();
                          setResetPassword(pw);
                          setShowResetPassword(true);
                        }}
                        title="Generate random password"
                      >
                        <RefreshCw className="h-4 w-4" />
                      </Button>
                      {resetPassword && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleCopyPassword(resetPassword)}
                          title="Copy password"
                        >
                          <Copy className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    onClick={handleResetPassword}
                    disabled={resetting || resetPassword.length < 8}
                  >
                    {resetting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Reset'}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setResetUserId(null);
                      setResetPassword('');
                      setShowResetPassword(false);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        ))}

        {users.length === 0 && (
          <div className="text-center py-12 text-muted-foreground">
            <p>No users found. Click &quot;Add User&quot; to create the first one.</p>
          </div>
        )}
      </div>
    </div>
  );
}
