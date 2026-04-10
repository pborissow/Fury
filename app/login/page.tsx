'use client';

import { useState, useEffect } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);

  // Check if already authenticated (whoami never sends WWW-Authenticate)
  useEffect(() => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/auth/whoami', true);
    xhr.setRequestHeader('Cache-Control', 'no-cache, no-transform');
    xhr.onreadystatechange = () => {
      if (xhr.readyState === 4) {
        if (xhr.status === 200) {
          window.location.replace('/');
        } else {
          setReady(true);
        }
      }
    };
    xhr.send(null);
  }, []);

  const handleLogin = () => {
    if (!username.trim() || !password.trim()) return;
    setError('');
    setLoading(true);

    // Target the ROOT path so the browser caches BASIC auth credentials
    // for /* (covers all paths on the origin). The middleware handles the
    // 401 + WWW-Authenticate challenge, the browser retries with credentials
    // from xhr.open(), and on success credentials are cached site-wide.
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/', true, username, password);
    xhr.setRequestHeader('Cache-Control', 'no-cache, no-transform');
    xhr.onreadystatechange = () => {
      if (xhr.readyState === 4) {
        setLoading(false);
        if (xhr.status === 200) {
          window.location.replace('/');
        } else {
          setError('Invalid username or password');
        }
      }
    };
    xhr.send(null);
  };

  if (!ready) return null;

  return (
    <div className="h-screen w-screen bg-background flex items-center justify-center">
      <div className="w-full max-w-sm border border-border rounded-lg p-6 bg-card shadow-lg">
        <h1 className="text-lg font-semibold text-foreground mb-1">Fury</h1>
        <p className="text-sm text-muted-foreground mb-6">Sign in to continue</p>

        <div className="space-y-3">
          <Input
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="off"
            name="fury-login-user"
            autoFocus
          />
          <div className="relative">
            <Input
              type={showPassword ? 'text' : 'password'}
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
              name="fury-login-pass"
              className="pr-9"
              onKeyDown={(e) => { if (e.key === 'Enter') handleLogin(); }}
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              tabIndex={-1}
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <Button
            type="button"
            className="w-full"
            onClick={handleLogin}
            disabled={!username.trim() || !password.trim() || loading}
          >
            {loading ? 'Signing in...' : 'Sign in'}
          </Button>
        </div>
      </div>
    </div>
  );
}
