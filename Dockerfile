FROM nginx:alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html
COPY avatar.png /usr/share/nginx/html/avatar.png
COPY Assets/ /usr/share/nginx/html/Assets/

EXPOSE 80 443
CMD ["nginx", "-g", "daemon off;"]
