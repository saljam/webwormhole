# Purpose
A quick guide on how to install, run, and configure _webwormhole_ on Ubuntu.

# Guide
## Install [golang](https://go.dev/dl/)
1. Open a new terminal window: Ctrl + Alt + T
2. Type: `cd /usr/local`
3. Type: `sudo wget https://go.dev/dl/go1.17.5.linux-amd64.tar.gz`
4. Type: `sudo tar xzf go1.17.5.linux-amd64.tar.gz`
5. Type: `sudo nano /etc/profile` and add `export PATH=$PATH:/usr/local/go/bin` to last line.
6. Close terminal by typing `exit`

Please verify go is installed properly by opening a new terminal window and typing: `go version` in which if everything is good to go, should show something similar to: `go version go1.17.5 linux/amd64`

## Create a new user
1. Open a new terminal window: Ctrl + Alt + T
2. Type: `sudo useradd -m -d /var/www/webwormhole -s /bin/bash -p webwormhole webwormhole`
3. Add a password (optional): `sudo passwd webwormhole`

## Download and build _webwormhole_
1. Open a new terminal window: Ctrl + Alt + T
2. Type: `sudo apt install build-essential git make`
3. Log into the webwormhole user: `sudo -iu webwormhole`
4. Type: `git clone https://github.com/saljam/webwormhole.git`
5. Type: `cd webwormhole`
6. Type: `make wasm`
7. Type: `go build -o ww ./cmd/ww/`
8. Type: `./ww server -help` for details on the binary you just created
9. Quit terminal: `exit` and `exit` again

## Create systemd service unit
1. Open a new terminal window: Ctrl + Alt + T
2. Type: `cd /etc/systemd/system`
3. Create new service file: `sudo nano webwormhole.service`
4. Copy these contents:

```
[Unit]
Description=Webwormhole (wss file mover)
After=syslog.target network.target remote-fs.target nss-lookup.target network-online.target
# You should add either your nginx or apache2 service in the "After" section as well
Requires=network-online.target

[Service]
Type=simple
Environment=USER=webwormhole
Environment=HOME=/var/www/webwormhole/
User=webwormhole
Group=webwormhole
ExecStart=/var/www/webwormhole/ww server -https= -http=localhost:7777 -hosts=webwormhole.my.domain -stun=stun:relay.webwormhole.io,stun:stun.nextcloud.com:443,stun:stun1.l.google.com:19302 -turn=turn:turn.my.domain:443 -turn-secret=shouldhavethoughtofabettersecurepassword
WorkingDirectory=/var/www/webwormhole/
TimeoutSec=30
RestartSec=2
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=webwormhole
Restart=always

### Modify these two values if you keep getting HTTP 500 errors
#LimitMEMLOCK=infinity
#LimitNOFILE=65535

### If you want to bind Webwormhole to a port below 1024 uncomment the two values below
#CapabilityBoundingSet=CAP_NET_BIND_SERVICE
#AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
```

5. Enable new service: `sudo systemctl enable webwormhole`
6. Start new service: `sudo systemctl start webwormhole`
7. Check the status with: `sudo systemctl status webwormhole` OR `sudo journalctl -fu webwormhole`

## Add reverse proxy config
1. Wherever your nginx server config files are, go there i.e. `cd /usr/local/nginx/conf/server`
2. Add a new file: `sudo nano webwormhole.conf`
3. Populate the contents of this file with:

```
server {
    listen 443 ssl http2;
    server_name webwormhole.my.domain;
    ssl_certificate /etc/letsencrypt/live/my.domain/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/my.domain/priv.pem;
### Change this to the max file size you want to be able to upload
    client_max_body_size 500M;
    ssl_session_cache  builtin:1000  shared:SSL:10m;
    ssl_session_timeout  10m;
    ssl_session_tickets off;
    ssl_protocols TLSv1.3 TLSv1.2;
    ssl_ciphers 'TLS-CHACHA20-POLY1305-SHA256:TLS-AES-256-GCM-SHA384:TLS-AES-128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-SHA384:ECDHE-RSA-AES256-SHA384:ECDHE-ECDSA-AES128-SHA256:ECDHE-RSA-AES128-SHA256';
    ssl_ecdh_curve secp384r1;
    ssl_stapling on;
    ssl_stapling_verify on;

    add_header Strict-Transport-Security max-age=15768000;
    add_header Referrer-Policy strict-origin-when-cross-origin;
    add_header X-Frame-Options deny;
    add_header X-Content-Type-Options nosniff;
    add_header X-XSS-Protection "1; mode=block";
    add_header Permissions-Policy "geolocation=(self), midi=(self), sync-xhr=(self), microphone=(self), camera=(self), magnetometer=(self), gyroscope=(self), fullscreen=(self), payment=(self)";

    location / {
        proxy_pass http://localhost:7000;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_ssl_verify off;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
    }
}
```
4. Restart nginx: `sudo service nginx restart`
