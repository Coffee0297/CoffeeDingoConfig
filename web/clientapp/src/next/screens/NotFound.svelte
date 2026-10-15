<script>
  import { PageHeader, Empty, Button } from '../ui/index.js'
  let { parts = [] } = $props()
</script>

<PageHeader title="Page not found" />
<Empty title="There is no screen at this address" text={'#/next/' + parts.join('/')}>
  {#snippet actions()}<Button variant="primary" href="#/next/car">Go to Car</Button>{/snippet}
</Empty>
