process.stdout.write((process.argv[2]||'').toLowerCase().includes('username') ? 'x-access-token' : (process.env.HG_GITHUB_TOKEN||''));
