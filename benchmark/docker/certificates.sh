#!/bin/sh
set -eu
cd /certs
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 7 -subj '/CN=Benchmark CA'
openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj '/CN=mongo-a'
printf 'subjectAltName=DNS:mongo-a,DNS:mongo-b,DNS:mongo-c,DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth,clientAuth\n' > server.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 7 -extfile server.ext
cat server.key server.crt > server.pem
openssl rand -base64 512 > keyfile
chmod 400 keyfile
chown 999:999 keyfile
chmod 644 server.pem ca.crt
rm ca.key server.key server.csr server.ext ca.srl
