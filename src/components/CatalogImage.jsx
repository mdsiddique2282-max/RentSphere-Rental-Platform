import { unavailablePhoto } from '../data/catalog';

export default function CatalogImage({ item, src, alt, ...props }) {
  return <img {...props} src={src || unavailablePhoto(item)} alt={alt}
    onError={event => {
      if (!event.currentTarget.src.startsWith('data:image/svg+xml,')) event.currentTarget.src = unavailablePhoto(item);
    }} />;
}
